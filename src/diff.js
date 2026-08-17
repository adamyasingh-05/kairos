// Minimal LCS-based unified diff + colored renderer.
import { c } from "./ui.js";

function lcs(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) ops.push(["=", a[i++], j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["-", a[i++]]);
    else ops.push(["+", b[j++]]);
  }
  while (i < m) ops.push(["-", a[i++]]);
  while (j < n) ops.push(["+", b[j++]]);
  return ops;
}

export function diffStats(oldText, newText) {
  const ops = lcs(oldText.split("\n"), newText.split("\n"));
  return {
    added: ops.filter((o) => o[0] === "+").length,
    removed: ops.filter((o) => o[0] === "-").length,
  };
}

export function renderDiff(oldText, newText, { context = 3 } = {}) {
  const ops = lcs(oldText.split("\n"), newText.split("\n"));
  const keep = new Set();
  ops.forEach((op, idx) => {
    if (op[0] !== "=") for (let k = idx - context; k <= idx + context; k++) keep.add(k);
  });
  const lines = [];
  let gap = false;
  ops.forEach((op, idx) => {
    if (!keep.has(idx)) {
      if (!gap) lines.push(c.gray("  ⋯"));
      gap = true;
      return;
    }
    gap = false;
    const [kind, text] = op;
    if (kind === "+") lines.push(c.green(`+ ${text}`));
    else if (kind === "-") lines.push(c.red(`- ${text}`));
    else lines.push(c.gray(`  ${text}`));
  });
  return lines;
}