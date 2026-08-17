// Kairos security layer: workspace sandbox, command policy, secret redaction.
import path from "node:path";
import fs from "node:fs";

export const ROOT = process.cwd();

const BLOCKED_DIRS = [".git/objects", "node_modules/.cache"];
const SENSITIVE = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)$/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.npmrc$/,
  /(^|\/)keys\.enc$/,
  /(^|\/)machine\.key$/,
  /(^|\/)\.kairos\/secrets/,
];

export function resolveInsideWorkspace(p) {
  const abs = path.resolve(ROOT, p);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Blocked: "${p}" is outside the workspace. Kairos never touches files above ${ROOT}.`);
  }
  if (BLOCKED_DIRS.some((d) => rel.startsWith(d))) throw new Error(`Blocked: "${rel}" is a protected path.`);
  return abs;
}

export function isSensitivePath(p) {
  const rel = path.relative(ROOT, path.resolve(ROOT, p)).split(path.sep).join("/");
  return SENSITIVE.some((re) => re.test(rel));
}

// Commands that are never run, even in auto mode.
const DENY = [
  /\brm\s+(-[a-z]*\s+)*(-rf|-fr)\b/i,
  /\bmkfs(\.|\b)/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{.*\};:/, // fork bomb
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /\bchown\s+-R\s+\/(\s|$)/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bcurl\b[^|]*\|\s*(ba)?sh/i,
  /\bwget\b[^|]*\|\s*(ba)?sh/i,
  /\bgit\s+push\b.*--force/i,
  /\b(sudo|doas|su)\b/,
  /\bnc\b\s+-\w*e/i,
  /\b(env|printenv)\b\s*$/,
  /\bcat\b[^\n]*\.(env|pem)\b/i,
  /~\/\.(ssh|aws|config\/kairos)/,
];

export function commandPolicy(cmd) {
  for (const re of DENY) {
    if (re.test(cmd)) return { allowed: false, reason: `matches Kairos deny-list rule ${re}` };
  }
  return { allowed: true };
}

// Redaction: any known secret value, plus anything shaped like an API key,
// is replaced before it can reach the screen, a session file, or a model prompt.
const KEY_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bxai-[A-Za-z0-9]{16,}\b/g,
  /\bgsk_[A-Za-z0-9]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

const liveSecrets = new Set();
export function trackSecret(value) {
  if (value && String(value).length >= 8) liveSecrets.add(String(value));
}

export function redact(text) {
  let out = String(text ?? "");
  for (const s of liveSecrets) out = out.split(s).join("«redacted»");
  for (const re of KEY_SHAPES) out = out.replace(re, "«redacted»");
  return out;
}

export function safeRead(file, maxBytes = 400_000) {
  const abs = resolveInsideWorkspace(file);
  const stat = fs.statSync(abs);
  if (stat.size > maxBytes) throw new Error(`File too large (${stat.size} bytes). Ask for a specific range.`);
  return fs.readFileSync(abs, "utf8");
}