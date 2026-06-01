import type { ReactNode } from "react";

// A real, interleaved, line-aligned diff for the tool-call cards — the way
// Claude Code / Codex / opencode render an edit. Replaces the old DiffLines,
// which dumped all removals then all additions as two flat blocks. The tool
// view already carries oldText/newText (parsed from the ACP tool input), so
// this is a pure presentation concern: align the two texts and render
// add/remove/context rows with old+new line-number gutters.

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

const ROW_TONE: Record<DiffRow["type"], string> = {
  context: "text-txt/80",
  add: "bg-ok/10 text-ok",
  remove: "bg-danger/10 text-danger",
};

const ROW_SIGN: Record<DiffRow["type"], string> = {
  context: " ",
  add: "+",
  remove: "-",
};

function Gutter({ value }: { value: number | null }): ReactNode {
  return (
    <span className="w-8 shrink-0 select-none px-1 text-right text-muted/50 tabular-nums">
      {value === null ? "" : value}
    </span>
  );
}

/**
 * Render an edit as an interleaved diff. When `oldText` is omitted (a file
 * write rather than an edit) every line is shown as an addition.
 */
export function DiffView({
  oldText,
  newText,
}: {
  oldText?: string;
  newText: string;
}): ReactNode {
  const rows: DiffRow[] =
    oldText === undefined
      ? newText.split("\n").map((text, idx) => ({
          type: "add" as const,
          oldLine: null,
          newLine: idx + 1,
          text,
        }))
      : lineDiff(oldText, newText);

  return (
    <div
      className="overflow-auto rounded-md border border-border/40 bg-bg/60 font-mono text-2xs leading-relaxed"
      style={{ maxHeight: "18rem" }}
      data-testid="orchestrator-diff"
    >
      {rows.map((row) => (
        // (oldLine, newLine) pairs are unique within a diff, so no index key.
        <div
          key={`${row.oldLine ?? "_"}:${row.newLine ?? "_"}:${row.type}`}
          className={`flex ${ROW_TONE[row.type]}`}
        >
          <Gutter value={row.oldLine} />
          <Gutter value={row.newLine} />
          <span className="w-3 shrink-0 select-none text-center opacity-70">
            {ROW_SIGN[row.type]}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">
            {row.text}
          </span>
        </div>
      ))}
    </div>
  );
}
