// Kairos TUI primitives — zero-dependency ANSI rendering.
const E = "\x1b[";
export const sgr = (...c) => `${E}${c.join(";")}m`;
export const RESET = `${E}0m`;

const supportsColor = () =>
  process.env["NO_COLOR"] === undefined && (process.stdout.isTTY || process.env["FORCE_COLOR"]);

const wrap = (open, s) => (supportsColor() ? `${open}${s}${RESET}` : String(s));

export const rgb = (r, g, b) => (s) => wrap(sgr(38, 2, r, g, b), s);
export const bgRgb = (r, g, b) => (s) => wrap(sgr(48, 2, r, g, b), s);

export const c = {
  dim: (s) => wrap(sgr(2), s),
  bold: (s) => wrap(sgr(1), s),
  italic: (s) => wrap(sgr(3), s),
  under: (s) => wrap(sgr(4), s),
  red: rgb(255, 95, 109),
  green: rgb(96, 224, 160),
  yellow: rgb(247, 201, 106),
  blue: rgb(120, 170, 255),
  violet: rgb(178, 140, 255),
  cyan: rgb(103, 232, 249),
  gray: rgb(140, 148, 168),
  white: rgb(232, 236, 245),
  amber: rgb(255, 176, 92),
};

// Kairos signature gradient: deep violet -> cyan.
const GRAD = [
  [150, 108, 255],
  [136, 130, 255],
  [120, 158, 255],
  [104, 190, 250],
  [96, 220, 236],
  [110, 240, 214],
];

export function gradient(text) {
  if (!supportsColor()) return text;
  const chars = [...text];
  const n = Math.max(chars.length - 1, 1);
  return (
    chars
      .map((ch, i) => {
        const p = (i / n) * (GRAD.length - 1);
        const a = GRAD[Math.floor(p)];
        const b = GRAD[Math.min(Math.ceil(p), GRAD.length - 1)];
        const t = p - Math.floor(p);
        const mix = a.map((v, k) => Math.round(v + (b[k] - v) * t));
        return `${sgr(38, 2, ...mix)}${ch}`;
      })
      .join("") + RESET
  );
}

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
export const width = (s) => [...stripAnsi(s)].length;

export function pad(s, w) {
  const diff = w - width(s);
  return diff > 0 ? s + " ".repeat(diff) : s;
}

export function wrapText(text, w) {
  const out = [];
  for (const raw of String(text).split("\n")) {
    if (width(raw) <= w) {
      out.push(raw);
      continue;
    }
    let line = "";
    for (const word of raw.split(" ")) {
      if (width(line) + width(word) + 1 > w && line) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export const term = () => ({
  cols: Math.min(process.stdout.columns || 96, 110),
  rows: process.stdout.rows || 30,
});

const B = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

export function box(body, { title = "", color = c.violet, footer = "" } = {}) {
  const w = term().cols - 2;
  const inner = w - 2;
  const lines = (Array.isArray(body) ? body : String(body).split("\n")).flatMap((l) =>
    wrapText(l, inner - 2),
  );
  const head = title
    ? `${B.tl}${B.h} ${title} ${B.h.repeat(Math.max(w - width(title) - 5, 0))}${B.tr}`
    : `${B.tl}${B.h.repeat(w - 2)}${B.tr}`;
  const foot = footer
    ? `${B.bl}${B.h} ${footer} ${B.h.repeat(Math.max(w - width(footer) - 5, 0))}${B.br}`
    : `${B.bl}${B.h.repeat(w - 2)}${B.br}`;
  const out = [color(head)];
  for (const l of lines) out.push(`${color(B.v)} ${pad(l, inner - 2)} ${color(B.v)}`);
  out.push(color(foot));
  return out.join("\n");
}

export function rule(label = "") {
  const w = term().cols - 2;
  if (!label) return c.gray("─".repeat(w));
  return c.gray(`── ${label} ${"─".repeat(Math.max(w - width(label) - 4, 0))}`);
}

export const banner = () => {
  const art = [
    "  ██╗  ██╗ █████╗ ██╗██████╗  ██████╗ ███████╗",
    "  ██║ ██╔╝██╔══██╗██║██╔══██╗██╔═══██╗██╔════╝",
    "  █████╔╝ ███████║██║██████╔╝██║   ██║███████╗",
    "  ██╔═██╗ ██╔══██║██║██╔══██╗██║   ██║╚════██║",
    "  ██║  ██╗██║  ██║██║██║  ██║╚██████╔╝███████║",
    "  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
  ];
  return art.map(gradient).join("\n");
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let active = null;
// Any prompt that needs the screen to itself calls this first.
export const stopSpinner = () => active?.stop();

export function spinner(label) {
  let i = 0;
  let t = null;
  const tty = process.stdout.isTTY;
  const draw = () => {
    if (!tty) return;
    process.stdout.write(`\r${E}2K${c.violet(FRAMES[i++ % FRAMES.length])} ${c.gray(label)}`);
  };
  if (tty) {
    draw();
    t = setInterval(draw, 80);
  }
  const handle = {
    update(next) {
      label = next;
    },
    stop(final = "") {
      if (t) clearInterval(t);
      t = null;
      if (active === handle) active = null;
      if (tty) process.stdout.write(`\r${E}2K`);
      if (final) console.log(final);
    },
  };
  active = handle;
  return handle;
}

export const log = (s = "") => console.log(s);
export const say = (icon, text, color = c.gray) => console.log(`${color(icon)} ${text}`);