#!/usr/bin/env node
import { start } from "../src/app.js";
import { PROVIDERS } from "../src/providers.js";
import { c, banner, gradient, log } from "../src/ui.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? true;
};

if (argv.includes("--help") || argv.includes("-h")) {
  log(banner());
  log(`
  ${gradient("kairos")} — a secure, provider-agnostic terminal coding agent

  ${c.white("kairos")}                     start the TUI in the current directory
  ${c.white("kairos \"add tests\"")}        run a single prompt, then drop into the TUI
  ${c.white("kairos --resume <id>")}       continue a saved session
  ${c.white("kairos --providers")}         list all ${PROVIDERS.length} supported providers
  ${c.white("kairos --version")}

  ${c.gray("Keys live in an AES-256-GCM vault on this machine. Kairos has no server.")}
`);
  process.exit(0);
}

if (argv.includes("--providers")) {
  for (const p of PROVIDERS) log(`${c.white(p.id.padEnd(16))} ${c.gray(p.name)}`);
  process.exit(0);
}

if (argv.includes("--version") || argv.includes("-v")) {
  log("kairos 0.1.0");
  process.exit(0);
}

const prompt = argv.filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--resume").join(" ");

process.on("SIGINT", () => {
  log(`\n${c.gray("  interrupted — session saved.")}`);
  process.exit(130);
});

start({ resume: flag("--resume"), prompt: prompt || null }).catch((err) => {
  console.error(c.red(`kairos: ${err?.message || err}`));
  process.exit(1);
});