// Kairos — main TUI application.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PROVIDERS, byId, search } from "./providers.js";
import { getKey, setKey, removeKey, listKeys, vaultExists, fingerprint } from "./keystore.js";
import { loadSettings, saveSettings, CONFIG_DIR } from "./config.js";
import { createSession, saveSession, loadSession, listSessions, checkpoint, rewind } from "./session.js";
import { runAgent } from "./agent.js";
import { verifyKey } from "./client.js";
import { trackSecret, redact, ROOT } from "./security.js";
import { createInput, askSecret, selectKey } from "./prompt.js";
import { banner, box, rule, c, log, gradient, spinner, stopSpinner, term, pad } from "./ui.js";

const PASSPHRASE = process.env["KAIROS_PASSPHRASE"] || "";

const gitBranch = () => {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

export async function start(opts = {}) {
  const settings = loadSettings();
  const io = createInput();
  let session = opts.resume ? loadSession(opts.resume) : createSession();
  const alwaysAllow = new Set();

  console.clear?.();
  log("");
  log(banner());
  log(
    `  ${gradient("Kairos")} ${c.gray("· the right moment to ship")}   ${c.dim("v0.1.0")}\n` +
      `  ${c.gray(ROOT)}${gitBranch() ? c.gray(`  ⎇ ${gitBranch()}`) : ""}`,
  );
  log("");
  log(
    box(
      [
        `${c.white("/login")}      store an API key (AES-256-GCM, never echoed, never logged)`,
        `${c.white("/provider")}   pick from ${PROVIDERS.length} providers   ${c.white("/model")}  choose a model`,
        `${c.white("/mode")}       approvals: prompt · auto-edit · readonly`,
        `${c.white("/checkpoint")} snapshot   ${c.white("/rewind")}  restore any earlier state`,
        `${c.white("/resume")}     continue a past session   ${c.white("/help")}  everything else`,
      ],
      { title: c.violet("getting started"), footer: c.gray("keys stay on this machine · nothing is ever uploaded to Kairos") },
    ),
  );
  log("");

  let provider = byId(settings.provider) || null;
  let model = settings.model || provider?.models[0] || null;
  if (!provider) {
    log(c.amber("  No provider selected yet — run /provider, then /login.\n"));
  }

  const approve = async ({ title, body, always }) => {
    if (settings.approvalMode === "auto-edit") return true;
    if (always && alwaysAllow.has(always)) return true;
    stopSpinner(); // never let a running spinner overwrite an approval prompt
    log("");
    log(box(body, { title: c.amber(title), color: c.amber, footer: c.gray("y approve · a approve all like this · n reject") }));
    process.stdout.write(`  ${c.amber("?")} approve  ${c.gray("[y/a/n]")} `);
    const key = await selectKey(["y", "a", "n"]);
    log(key === "n" ? c.red(" rejected") : c.green(" approved"));
    if (key === "a" && always) alwaysAllow.add(always);
    return key !== "n";
  };

  let currentCheckpoint = null;
  const cp = () => currentCheckpoint;

  const statusline = () => {
    const parts = [
      provider ? c.violet(provider.name) : c.red("no provider"),
      model ? c.cyan(model) : c.red("no model"),
      c.gray(settings.approvalMode),
      c.gray(`${session.messages.filter((m) => m.role === "user").length} turns`),
    ];
    return `${c.gray("┌")} ${parts.join(c.gray(" · "))}`;
  };

  const commands = {
    async help() {
      log(
        box(
          [
            `${c.white("/provider [name]")}  browse or set one of ${PROVIDERS.length} providers`,
            `${c.white("/model [name]")}     set the model id`,
            `${c.white("/login")}            paste an API key into the encrypted vault`,
            `${c.white("/logout <id>")}      remove a stored key`,
            `${c.white("/keys")}             list stored keys (fingerprints only)`,
            `${c.white("/mode")}             cycle approvals: prompt → auto-edit → readonly`,
            `${c.white("/shell")}            toggle command execution on/off`,
            `${c.white("/checkpoint [tag]")} snapshot the working tree state`,
            `${c.white("/rewind [n]")}       restore files + history to a checkpoint`,
            `${c.white("/sessions")}         list past sessions`,
            `${c.white("/resume <id>")}      continue a past session`,
            `${c.white("/diff")}             git diff --stat of the workspace`,
            `${c.white("/security")}         show the security posture of this install`,
            `${c.white("/clear")}            clear conversation context`,
            `${c.white("/exit")}             leave (Ctrl+C also works)`,
          ],
          { title: c.violet("commands") },
        ),
      );
    },
    async provider(arg) {
      if (!arg) {
        const cols = 2;
        const w = Math.floor((term().cols - 8) / cols);
        const rows = [];
        PROVIDERS.forEach((p, i) => {
          const cell = `${c.gray(String(i + 1).padStart(2))} ${c.white(pad(p.name, 26))} ${c.gray(p.id)}`;
          if (i % cols === 0) rows.push(pad(cell, w));
          else rows[rows.length - 1] += pad(cell, w);
        });
        log(box(rows, { title: c.violet(`${PROVIDERS.length} providers`), footer: c.gray("/provider <id or number>") }));
        return;
      }
      const picked = /^\d+$/.test(arg) ? PROVIDERS[Number(arg) - 1] : byId(arg) || search(arg)[0];
      if (!picked) return log(c.red(`  No provider matches “${arg}”.`));
      provider = picked;
      model = picked.models[0];
      settings.provider = picked.id;
      settings.model = model;
      saveSettings(settings);
      log(`  ${c.green("✔")} ${c.white(picked.name)} ${c.gray(`· ${model}`)}`);
      if (!getKey(picked, PASSPHRASE)) log(`  ${c.amber("!")} no key stored — run ${c.white("/login")} (get one at ${c.gray(picked.keyUrl)})`);
    },
    async model(arg) {
      if (!provider) return log(c.red("  Pick a provider first."));
      if (!arg) return log(box(provider.models.map((m) => `${c.white(m)}`), { title: c.violet(`${provider.name} models`), footer: c.gray("/model <id> — any id the provider accepts works") }));
      model = arg;
      settings.model = arg;
      saveSettings(settings);
      log(`  ${c.green("✔")} model → ${c.cyan(arg)}`);
    },
    async login(arg) {
      const target = arg ? byId(arg) || search(arg)[0] : provider;
      if (!target) return log(c.red("  Usage: /login <provider-id>"));
      log("");
      log(box(
        [
          `Provider: ${c.white(target.name)}`,
          `Get a key: ${c.gray(target.keyUrl)}`,
          "",
          c.gray("Your key is encrypted with AES-256-GCM before it touches the disk,"),
          c.gray("bound to this machine, never echoed, never logged, never sent anywhere"),
          c.gray(`except ${new URL(target.baseUrl).host}.`),
        ],
        { title: c.violet("store an API key"), color: c.violet },
      ));
      const key = await askSecret(`  ${c.violet("paste key")} ${c.gray("(hidden)")} › `);
      if (!key.trim()) return log(c.gray("  cancelled"));
      trackSecret(key.trim());
      const spin = spinner("verifying key with the provider…");
      try {
        await verifyKey(target, key.trim());
        spin.stop();
        log(`  ${c.green("✔")} key verified`);
      } catch (e) {
        spin.stop();
        log(`  ${c.amber("!")} could not verify (${redact(e.message).split("\n")[0]})`);
        process.stdout.write(`  store it anyway? ${c.gray("[y/n]")} `);
        const k = await selectKey(["y", "n"]);
        log("");
        if (k === "n") return;
      }
      setKey(target.id, key.trim(), PASSPHRASE);
      provider = target;
      model = settings.model && settings.provider === target.id ? model : target.models[0];
      settings.provider = target.id;
      settings.model = model;
      saveSettings(settings);
      log(`  ${c.green("✔")} stored ${c.white(target.name)} key ${c.gray(`#${fingerprint(key.trim())}`)} in ${c.gray(CONFIG_DIR)}`);
    },
    async logout(arg) {
      if (!arg) return log(c.red("  Usage: /logout <provider-id>"));
      removeKey(arg, PASSPHRASE);
      log(`  ${c.green("✔")} removed ${arg}`);
    },
    async keys() {
      if (!vaultExists()) return log(c.gray("  Vault is empty. /login to add a key."));
      const rows = listKeys(PASSPHRASE).map(
        (k) => `${c.white(pad(byId(k.id)?.name || k.id, 28))} ${c.gray(`#${k.fingerprint}`)}  ${c.gray(new Date(k.added).toLocaleDateString())}`,
      );
      log(box(rows.length ? rows : [c.gray("(none)")], { title: c.violet("stored keys"), footer: c.gray("values are never displayed — only SHA-256 fingerprints") }));
    },
    async mode() {
      const order = ["prompt", "auto-edit", "readonly"];
      settings.approvalMode = order[(order.indexOf(settings.approvalMode) + 1) % order.length];
      saveSettings(settings);
      log(`  ${c.green("✔")} approval mode → ${c.white(settings.approvalMode)}`);
    },
    async shell() {
      settings.allowShell = !settings.allowShell;
      saveSettings(settings);
      log(`  ${c.green("✔")} shell execution ${settings.allowShell ? c.green("enabled") : c.red("disabled")}`);
    },
    async checkpoint(tag) {
      const created = checkpoint(session, tag || `manual ${session.checkpoints.length + 1}`);
      saveSession(session);
      log(`  ${c.green("✔")} checkpoint #${created.id} ${c.gray(created.label)}`);
    },
    async rewind(arg) {
      if (!session.checkpoints.length) return log(c.gray("  No checkpoints yet."));
      if (!arg) {
        return log(
          box(
            session.checkpoints.map((cpt) => `${c.white(`#${cpt.id}`)} ${pad(cpt.label, 30)} ${c.gray(`${Object.keys(cpt.files).length} files`)}`),
            { title: c.violet("checkpoints"), footer: c.gray("/rewind <n>") },
          ),
        );
      }
      const files = rewind(session, Number(arg));
      saveSession(session);
      log(`  ${c.green("✔")} rewound to #${arg} — restored ${files.length} file(s)`);
    },
    async sessions() {
      const all = listSessions();
      log(
        box(
          all.length
            ? all.slice(0, 15).map((s) => `${c.white(pad(s.id, 26))} ${c.gray(pad(`${s.turns} turns`, 10))} ${c.gray(s.title)}`)
            : [c.gray("(none yet)")],
          { title: c.violet("sessions"), footer: c.gray("/resume <id>") },
        ),
      );
    },
    async resume(arg) {
      if (!arg) return commands.sessions();
      session = loadSession(arg);
      log(`  ${c.green("✔")} resumed ${arg} ${c.gray(`(${session.messages.length} messages)`)}`);
    },
    async diff() {
      try {
        const out = execFileSync("git", ["diff", "--stat"], { cwd: ROOT }).toString().trim();
        log(box(out ? out.split("\n") : [c.gray("clean working tree")], { title: c.violet("git diff"), color: c.blue }));
      } catch {
        log(c.gray("  Not a git repository."));
      }
    },
    async security() {
      const st = (() => {
        try {
          return (fs.statSync(path.join(CONFIG_DIR, "keys.enc")).mode & 0o777).toString(8);
        } catch {
          return "—";
        }
      })();
      log(
        box(
          [
            `${c.green("✔")} keys encrypted at rest      ${c.gray("AES-256-GCM + scrypt(N=32768), machine-bound")}`,
            `${c.green("✔")} vault permissions           ${c.gray(`${CONFIG_DIR}/keys.enc mode ${st}`)}`,
            `${c.green("✔")} zero telemetry              ${c.gray("no analytics, no crash reports, no key sync")}`,
            `${c.green("✔")} zero runtime dependencies   ${c.gray("no npm supply chain in the hot path")}`,
            `${c.green("✔")} workspace sandbox           ${c.gray(`file access confined to ${ROOT}`)}`,
            `${c.green("✔")} credential files refused    ${c.gray(".env, .ssh, .aws, .npmrc are never read into a prompt")}`,
            `${c.green("✔")} command deny-list           ${c.gray("destructive + exfiltration patterns blocked pre-approval")}`,
            `${c.green("✔")} scrubbed subprocess env     ${c.gray("child processes never inherit *_API_KEY / *_TOKEN")}`,
            `${c.green("✔")} output redaction            ${c.gray("key-shaped strings masked in screen, logs and sessions")}`,
            `${c.green("✔")} passphrase mode             ${c.gray(PASSPHRASE ? "active" : "set KAIROS_PASSPHRASE to add one")}`,
          ],
          { title: c.violet("security posture"), color: c.green },
        ),
      );
    },
    async clear() {
      session = createSession();
      log(`  ${c.green("✔")} context cleared`);
    },
    async exit() {
      throw { __exit: true };
    },
  };
  commands.quit = commands.exit;
  commands.q = commands.exit;
  commands.p = commands.provider;
  commands.m = commands.model;

  if (opts.prompt) await turn(opts.prompt);

  async function turn(input) {
    if (!provider) return log(c.red("  Pick a provider with /provider first."));
    const apiKey = getKey(provider, PASSPHRASE);
    if (!apiKey) return log(c.red(`  No API key for ${provider.name}. Run /login.`));
    trackSecret(apiKey);

    session.messages.push({ role: "user", content: input });
    currentCheckpoint = checkpoint(session, input.slice(0, 40));
    const started = Date.now();
    try {
      await runAgent({ session, provider, model, apiKey, settings, approve, cp });
    } catch (err) {
      log(box([redact(err.message || String(err))], { title: c.red("error"), color: c.red }));
    }
    saveSession(session);
    log(c.gray(`  ${((Date.now() - started) / 1000).toFixed(1)}s · checkpoint #${currentCheckpoint.id} · /rewind ${currentCheckpoint.id} to undo`));
    log("");
  }

  // Main loop
  for (;;) {
    log(statusline());
    const line = (await io.ask(`${c.gray("└")} ${gradient("›")} `)).trim();
    if (!line) continue;
    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(" ");
      const handler = commands[cmd];
      if (!handler) {
        log(c.red(`  Unknown command /${cmd} — try /help`));
        continue;
      }
      try {
        await handler(rest.join(" ").trim());
      } catch (e) {
        if (e?.__exit) break;
        log(box([redact(e.message || String(e))], { title: c.red("error"), color: c.red }));
      }
      log("");
      continue;
    }
    await turn(line);
  }

  io.close();
  log(`${gradient("  ✦ kairos out.")} ${c.gray("session saved as")} ${c.white(session.id)}\n`);
}