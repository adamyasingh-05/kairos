import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const HOME = os.homedir();
export const CONFIG_DIR =
  process.env["KAIROS_HOME"] ||
  path.join(process.env["XDG_CONFIG_HOME"] || path.join(HOME, ".config"), "kairos");

export const KEYS_FILE = path.join(CONFIG_DIR, "keys.enc");
export const MACHINE_FILE = path.join(CONFIG_DIR, "machine.key");
export const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.json");
export const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");

export function ensureDir(dir = CONFIG_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort on non-POSIX */
  }
  return dir;
}

export function writePrivate(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

const DEFAULTS = {
  provider: null,
  model: null,
  approvalMode: "prompt", // prompt | auto-edit | readonly
  allowShell: true,
  telemetry: false, // Kairos never phones home. Kept here so it is auditable.
  maxSteps: 40,
  temperature: 0.2,
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  writePrivate(SETTINGS_FILE, JSON.stringify(s, null, 2));
}