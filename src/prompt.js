// Input helpers built on raw stdin, so secrets never echo and never reach
// shell history.
import readline from "node:readline";

// The active line-editor. While a secret or a single keypress is being read we
// must pause it: readline echoes every keystroke it sees, which would print an
// API key to the screen and into the scrollback.
let activeRl = null;

export function createInput() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 200 });
  activeRl = rl;
  return {
    rl,
    ask: (q) => new Promise((res) => rl.question(q, (a) => res(a))),
    close: () => {
      if (activeRl === rl) activeRl = null;
      rl.close();
    },
  };
}

// Detach the line editor (no echo, no history) and hand raw stdin back afterwards.
function takeStdin() {
  const { stdin } = process;
  const rl = activeRl;
  rl?.pause();
  // readline.pause() only pauses the stream — its listeners stay attached and
  // would echo every keystroke as soon as we resume stdin. Detach them for the
  // duration of the raw read and put them back exactly as they were.
  const saved = { data: stdin.listeners("data"), keypress: stdin.listeners("keypress") };
  for (const [event, listeners] of Object.entries(saved)) {
    for (const listener of listeners) stdin.off(event, listener);
  }
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  return (handler) => {
    stdin.off("data", handler);
    if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
    for (const [event, listeners] of Object.entries(saved)) {
      for (const listener of listeners) stdin.on(event, listener);
    }
    if (rl) rl.resume();
    else stdin.pause();
  };
}

// Reads a line without echoing anything. Used only for API keys and the
// vault passphrase.
export function askSecret(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    const release = takeStdin();
    let buf = "";
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        if (ch >= " ") buf += ch;
      }
    };
    const cleanup = () => release(onData);
    stdin.on("data", onData);
  });
}

// Single-keypress menu selector.
export function selectKey(valid) {
  return new Promise((resolve) => {
    const { stdin } = process;
    const release = takeStdin();
    const onData = (chunk) => {
      const ch = chunk.toString("utf8").toLowerCase();
      if (ch === "\u0003") {
        done();
        process.exit(130);
      }
      if (valid.includes(ch)) {
        done();
        resolve(ch);
      }
    };
    const done = () => release(onData);
    stdin.on("data", onData);
  });
}