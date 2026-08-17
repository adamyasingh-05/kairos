// Agent tools. Every mutation goes through the sandbox + approval gate.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveInsideWorkspace, isSensitivePath, commandPolicy, redact, ROOT, safeRead } from "./security.js";
import { renderDiff, diffStats } from "./diff.js";
import { recordFile } from "./session.js";
import { c, box, log } from "./ui.js";

const exec = promisify(execFile);
const IGNORE = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", ".turbo", "coverage", ".output"]);

function walk(dir, out = [], depth = 0) {
  if (depth > 8 || out.length > 4000) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out, depth + 1);
    else out.push(path.relative(ROOT, abs));
  }
  return out;
}

export function buildTools(ctx) {
  const readonly = ctx.settings.approvalMode === "readonly";

  const tools = [
    {
      name: "list_files",
      description: "List workspace files, optionally filtered by a glob-ish substring.",
      parameters: {
        type: "object",
        properties: { filter: { type: "string", description: "substring to match in the path" } },
      },
      run: async ({ filter }) => {
        const files = walk(ROOT).filter((f) => (filter ? f.includes(filter) : true));
        return files.slice(0, 500).join("\n") + (files.length > 500 ? `\n… ${files.length - 500} more` : "");
      },
      summary: (a) => `list files${a.filter ? ` matching “${a.filter}”` : ""}`,
    },
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      run: async ({ path: p }) => {
        if (isSensitivePath(p)) throw new Error(`Refused: "${p}" may contain credentials. Kairos never reads secrets into a prompt.`);
        const text = safeRead(p);
        return redact(text.split("\n").map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n"));
      },
      summary: (a) => `read ${a.path}`,
    },
    {
      name: "search_code",
      description: "Regex search across workspace files. Returns path:line matches.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, glob: { type: "string" } },
        required: ["pattern"],
      },
      run: async ({ pattern, glob }) => {
        const re = new RegExp(pattern, "gi");
        const hits = [];
        for (const rel of walk(ROOT)) {
          if (glob && !rel.includes(glob)) continue;
          let text;
          try {
            text = fs.readFileSync(path.join(ROOT, rel), "utf8");
          } catch {
            continue;
          }
          text.split("\n").forEach((line, i) => {
            re.lastIndex = 0;
            if (re.test(line) && hits.length < 200) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
        return redact(hits.join("\n") || "no matches");
      },
      summary: (a) => `search /${a.pattern}/`,
    },
    {
      name: "write_file",
      description: "Create or overwrite a file. Shows a diff and requires approval.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      mutates: true,
      run: async ({ path: p, content }) => applyWrite(ctx, p, content),
      summary: (a) => `write ${a.path}`,
    },
    {
      name: "edit_file",
      description: "Replace an exact snippet in a file. Prefer this over rewriting whole files.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
        required: ["path", "find", "replace"],
      },
      mutates: true,
      run: async ({ path: p, find, replace }) => {
        const before = safeRead(p);
        if (!before.includes(find)) throw new Error("The `find` snippet was not found verbatim. Read the file again.");
        return applyWrite(ctx, p, before.replace(find, replace));
      },
      summary: (a) => `edit ${a.path}`,
    },
    {
      name: "delete_file",
      description: "Delete a workspace file (checkpointed, so /rewind restores it).",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      mutates: true,
      run: async ({ path: p }) => {
        const abs = resolveInsideWorkspace(p);
        const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
        if (before === null) return `${p} does not exist`;
        const ok = await ctx.approve({ title: `Delete ${p}`, body: [c.red(`This removes ${p} (${before.split("\n").length} lines).`)] });
        if (!ok) return "User declined the deletion.";
        recordFile(ctx.cp(), abs, before);
        fs.unlinkSync(abs);
        return `deleted ${p}`;
      },
      summary: (a) => `delete ${a.path}`,
    },
    {
      name: "run_command",
      description: "Run a shell command in the workspace. Requires approval and passes a deny-list policy.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, why: { type: "string" } },
        required: ["command"],
      },
      mutates: true,
      run: async ({ command, why }) => {
        if (!ctx.settings.allowShell) return "Shell execution is disabled in this session (/shell to toggle).";
        const policy = commandPolicy(command);
        if (!policy.allowed) return `Blocked by Kairos security policy: ${policy.reason}`;
        const ok = await ctx.approve({
          title: "Run command",
          body: [c.amber(`$ ${command}`), ...(why ? [c.gray(why)] : [])],
          always: `cmd:${command}`,
        });
        if (!ok) return "User declined to run the command.";
        try {
          const { stdout, stderr } = await exec(process.env["SHELL"] || "/bin/sh", ["-c", command], {
            cwd: ROOT,
            timeout: 120_000,
            maxBuffer: 4_000_000,
            env: scrubEnv(),
          });
          return redact(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim() || "(no output)");
        } catch (e) {
          return redact(`command failed (${e.code ?? "error"}):\n${e.stdout || ""}\n${e.stderr || e.message}`);
        }
      },
      summary: (a) => `run \`${a.command}\``,
    },
    {
      name: "git",
      description: "Git helper: status | diff | log | branch <name> | stage <paths> | commit <message>.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "status|diff|log|branch|stage|commit" },
          value: { type: "string" },
        },
        required: ["action"],
      },
      mutates: true,
      run: async ({ action, value }) => gitTool(ctx, action, value),
      summary: (a) => `git ${a.action}${a.value ? ` ${String(a.value).slice(0, 40)}` : ""}`,
    },
  ];

  return readonly ? tools.filter((t) => !t.mutates) : tools;
}

// Never hand the child process our provider keys or the vault passphrase.
function scrubEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/(_API_KEY|_TOKEN|SECRET|PASSWORD|_PAT|KAIROS_PASSPHRASE)$/i.test(k)) delete env[k];
  }
  return env;
}

async function applyWrite(ctx, p, content) {
  const abs = resolveInsideWorkspace(p);
  if (isSensitivePath(p)) throw new Error(`Refused: "${p}" is a credential file.`);
  const exists = fs.existsSync(abs);
  const before = exists ? fs.readFileSync(abs, "utf8") : "";
  if (before === content) return `${p} already matches — no change.`;
  const stats = diffStats(before, content);

  const ok = await ctx.approve({
    title: `${exists ? "Edit" : "Create"} ${p}  ${c.green(`+${stats.added}`)} ${c.red(`-${stats.removed}`)}`,
    body: renderDiff(before, content).slice(0, 120),
    always: "edits",
  });
  if (!ok) return "User declined the change.";

  recordFile(ctx.cp(), abs, exists ? before : null);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return `${exists ? "updated" : "created"} ${p} (+${stats.added}/-${stats.removed})`;
}

async function git(args) {
  try {
    const { stdout } = await exec("git", args, { cwd: ROOT, maxBuffer: 4_000_000, env: scrubEnv() });
    return stdout.trim() || "(ok)";
  } catch (e) {
    return `git failed: ${e.stderr || e.message}`;
  }
}

async function gitTool(ctx, action, value) {
  switch (action) {
    case "status":
      return git(["status", "--short", "--branch"]);
    case "diff":
      return redact(await git(["diff", "--stat", ...(value ? ["--", value] : [])]));
    case "log":
      return git(["log", "--oneline", "-15"]);
    case "branch": {
      const ok = await ctx.approve({ title: "Create branch", body: [c.amber(`git checkout -b ${value}`)] });
      return ok ? git(["checkout", "-b", String(value)]) : "User declined.";
    }
    case "stage":
      return git(["add", ...(value ? value.split(/\s+/) : ["-A"])]);
    case "commit": {
      const ok = await ctx.approve({ title: "Commit", body: [c.amber(String(value))] });
      if (!ok) return "User declined the commit.";
      return git(["commit", "-m", String(value)]);
    }
    default:
      return `Unknown git action "${action}".`;
  }
}

export function renderToolPanel(title, body) {
  log(box(body, { title, color: c.blue }));
}