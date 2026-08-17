// Sessions + checkpoints: resume any conversation, rewind the filesystem.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR, ensureDir, writePrivate } from "./config.js";
import { redact } from "./security.js";

export function createSession(meta = {}) {
  ensureDir(SESSIONS_DIR);
  const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomBytes(3).toString("hex");
  return { id, created: Date.now(), cwd: process.cwd(), messages: [], checkpoints: [], ...meta };
}

export const sessionFile = (id) => path.join(SESSIONS_DIR, `${id}.json`);

export function saveSession(session) {
  writePrivate(sessionFile(session.id), redact(JSON.stringify(session, null, 2)));
}

export function loadSession(id) {
  return JSON.parse(fs.readFileSync(sessionFile(id), "utf8"));
}

export function listSessions() {
  try {
    return fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
        return {
          id: s.id,
          cwd: s.cwd,
          created: s.created,
          turns: s.messages.filter((m) => m.role === "user").length,
          title: s.title || s.messages.find((m) => m.role === "user")?.content?.slice(0, 60) || "(empty)",
        };
      })
      .sort((a, b) => b.created - a.created);
  } catch {
    return [];
  }
}

// A checkpoint stores the pre-edit content of every file the turn touched,
// so /rewind restores the tree exactly.
export function checkpoint(session, label) {
  const cp = { id: session.checkpoints.length + 1, label, at: Date.now(), files: {}, messageCount: session.messages.length };
  session.checkpoints.push(cp);
  return cp;
}

export function recordFile(cp, absPath, beforeContent) {
  if (cp && !(absPath in cp.files)) cp.files[absPath] = beforeContent;
}

export function rewind(session, checkpointId) {
  const idx = session.checkpoints.findIndex((cp) => cp.id === checkpointId);
  if (idx === -1) throw new Error(`No checkpoint #${checkpointId}`);
  const restored = [];
  for (let i = session.checkpoints.length - 1; i >= idx; i--) {
    const cp = session.checkpoints[i];
    for (const [file, before] of Object.entries(cp.files)) {
      if (before === null) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, before);
      }
      restored.push(file);
    }
  }
  const target = session.checkpoints[idx];
  session.messages = session.messages.slice(0, target.messageCount);
  session.checkpoints = session.checkpoints.slice(0, idx);
  return [...new Set(restored)];
}