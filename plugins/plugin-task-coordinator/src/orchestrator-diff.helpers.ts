// Pure line-diff helpers for the tool-call cards, split out of orchestrator-diff.tsx
// so that file exports only React components (+ the DiffRow type) and stays
// Fast-Refresh-compatible. A real, interleaved, line-aligned diff — the way
// Claude Code / Codex / opencode render an edit.

export interface DiffRow {
  type: "context" | "add" | "remove";
  /** 1-based line number in the old text, or null for an addition. */
  oldLine: number | null;
  /** 1-based line number in the new text, or null for a removal. */
  newLine: number | null;
  text: string;
}

/** Above this combined line count the O(n·m) alignment is skipped for a flat
 * remove-then-add render. Callers pass clamped text, so this is a backstop. */
const MAX_ALIGN_LINES = 800;

/** The minimal interleaved add/remove/context sequence aligning `oldText` to
 * `newText`, via the classic LCS dynamic program. */
export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  if (n + m > MAX_ALIGN_LINES) {
    const flat: DiffRow[] = [];
    for (let i = 0; i < n; i++)
      flat.push({ type: "remove", oldLine: i + 1, newLine: null, text: a[i] });
    for (let j = 0; j < m; j++)
      flat.push({ type: "add", oldLine: null, newLine: j + 1, text: b[j] });
    return flat;
  }

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({
        type: "context",
        oldLine: oldNo++,
        newLine: newNo++,
        text: a[i],
      });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({
        type: "remove",
        oldLine: oldNo++,
        newLine: null,
        text: a[i],
      });
      i++;
    } else {
      rows.push({ type: "add", oldLine: null, newLine: newNo++, text: b[j] });
      j++;
    }
  }
  while (i < n)
    rows.push({
      type: "remove",
      oldLine: oldNo++,
      newLine: null,
      text: a[i++],
    });
  while (j < m)
    rows.push({ type: "add", oldLine: null, newLine: newNo++, text: b[j++] });
  return rows;
}

/** Count added vs removed lines in an already-aligned diff, so a tool header
 * can show the edit magnitude without re-running the alignment. */
export function countDiff(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.type === "add") added++;
    else if (row.type === "remove") removed++;
  }
  return { added, removed };
}
