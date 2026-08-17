// Kairos keystore — API keys are encrypted at rest with AES-256-GCM.
//
// Threat model / guarantees:
//  * Keys never touch disk in plaintext, never enter shell history, never get logged.
//  * File is 0600 inside a 0700 directory.
//  * Encryption key = scrypt(passphrase || machine secret, per-file random salt).
//    The machine secret is 32 random bytes in a separate 0600 file, so copying
//    keys.enc to another machine is useless without it.
//  * AES-GCM auth tag detects any tampering with the vault.
//  * Keys are redacted from every rendered surface (see security.js).
import crypto from "node:crypto";
import fs from "node:fs";
import { KEYS_FILE, MACHINE_FILE, writePrivate } from "./config.js";

const VERSION = 1;

function machineSecret() {
  try {
    const raw = fs.readFileSync(MACHINE_FILE);
    if (raw.length >= 32) return raw.subarray(0, 32);
  } catch {
    /* create below */
  }
  const secret = crypto.randomBytes(32);
  writePrivate(MACHINE_FILE, secret);
  return secret;
}

function deriveKey(salt, passphrase) {
  const material = Buffer.concat([
    machineSecret(),
    Buffer.from(passphrase || "", "utf8"),
  ]);
  return crypto.scryptSync(material, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

export function vaultExists() {
  return fs.existsSync(KEYS_FILE);
}

export function readVault(passphrase = "") {
  if (!vaultExists()) return {};
  const blob = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  if (blob.v !== VERSION) throw new Error("Unsupported keystore version");
  const key = deriveKey(Buffer.from(blob.salt, "base64"), passphrase);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  try {
    const plain = Buffer.concat([
      decipher.update(Buffer.from(blob.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plain);
  } catch {
    throw new Error("Could not unlock the vault (wrong passphrase, or the file was tampered with)");
  }
}

export function writeVault(entries, passphrase = "") {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(salt, passphrase);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(entries), "utf8")),
    cipher.final(),
  ]);
  writePrivate(
    KEYS_FILE,
    JSON.stringify(
      {
        v: VERSION,
        kdf: "scrypt",
        cipher: "aes-256-gcm",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
        updated: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

export function setKey(providerId, apiKey, passphrase = "") {
  const vault = readVault(passphrase);
  vault[providerId] = { key: apiKey, added: new Date().toISOString() };
  writeVault(vault, passphrase);
  // Wipe our local reference eagerly; the caller should do the same.
  apiKey = null;
}

export function removeKey(providerId, passphrase = "") {
  const vault = readVault(passphrase);
  delete vault[providerId];
  writeVault(vault, passphrase);
}

export function getKey(provider, passphrase = "") {
  try {
    const vault = readVault(passphrase);
    if (vault[provider.id]?.key) return vault[provider.id].key;
  } catch {
    /* fall through to env */
  }
  return provider.env ? process.env[provider.env] || null : null;
}

export function listKeys(passphrase = "") {
  const vault = readVault(passphrase);
  return Object.entries(vault).map(([id, v]) => ({ id, added: v.added, fingerprint: fingerprint(v.key) }));
}

// A stable, non-reversible identifier so users can tell which key is stored
// without ever displaying the secret itself.
export function fingerprint(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 8);
}