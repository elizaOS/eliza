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

/**
 * Compact '+N −M' magnitude badge for a tool-call header. Green addition count
 * + red removal count (meaning-correct; see ROW_TONE), neutral otherwise.
 */
export function DiffStat({
  added,
  removed,
}: {
  added: number;
  removed: number;
}): ReactNode {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-2xs tabular-nums">
      <span className="text-ok">+{added}</span>
      <span className="text-red-500">&minus;{removed}</span>
    </span>
  );
}

// Meaning-only color: green for additions (--ok), red for deletions, muted for
// everything unchanged. No fills heavier than /10 so the palette stays calm.
const ROW_TONE: Record<DiffRow["type"], string> = {
  context: "text-muted",
  add: "bg-ok/10 text-ok",
  remove: "bg-red-500/10 text-red-500",
};

const ROW_SIGN: Record<DiffRow["type"], string> = {
  context: "",
  add: "+",
  remove: "-",
};

/** A run of unchanged lines longer than this is folded to a divider. Three
 * lines of context are kept on each inner edge of the fold (git/Codex style),
 * so a fold only appears when there is something to actually hide. */
const CONTEXT_FOLD_THRESHOLD = 6;
const CONTEXT_EDGE = 3;

/** A folded gap stands in for `hidden` consecutive context rows. It is purely
 * derived from the row sequence — no state, no expansion — matching Codex's
 * non-interactive "⋯ N unchanged" divider. */
interface FoldRow {
  type: "fold";
  hidden: number;
  /** Stable key from the surrounding line numbers. */
  key: string;
}

type ViewRow = DiffRow | FoldRow;

/** Collapse long runs of context into fold dividers. Leading/trailing context
 * keeps only its inner-facing edge (no point showing context before the first
 * change or after the last one beyond what frames it). Pure + stateless. */
function foldContext(rows: DiffRow[]): ViewRow[] {
  const out: ViewRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type !== "context") {
      out.push(rows[i]);
      i++;
      continue;
    }
    // Gather the maximal run of context rows starting at i.
    let j = i;
    while (j < rows.length && rows[j].type === "context") j++;
    const run = rows.slice(i, j);
    const atStart = i === 0;
    const atEnd = j === rows.length;
    const head = atStart ? 0 : CONTEXT_EDGE;
    const tail = atEnd ? 0 : CONTEXT_EDGE;
    const hidden = run.length - head - tail;

    // Fold only a genuinely long run, and only when the kept edges still leave
    // something worth tucking behind the divider.
    if (run.length > CONTEXT_FOLD_THRESHOLD && hidden > 0) {
      for (let k = 0; k < head; k++) out.push(run[k]);
      const before = head > 0 ? run[head - 1] : undefined;
      const after = run[run.length - tail] ?? run[run.length - 1];
      out.push({
        type: "fold",
        hidden,
        key: `fold:${before?.oldLine ?? "_"}:${after?.newLine ?? "_"}`,
      });
      for (let k = run.length - tail; k < run.length; k++) out.push(run[k]);
    } else {
      for (const row of run) out.push(row);
    }
    i = j;
  }
  return out;
}

function Gutter({ value }: { value: number | null }): ReactNode {
  return (
    <span className="w-8 shrink-0 select-none px-1 text-right text-muted/40 tabular-nums">
      {value ?? ""}
    </span>
  );
}

/** The "⋯ N unchanged" divider for a folded run of context. */
function FoldDivider({ hidden }: { hidden: number }): ReactNode {
  return (
    <div className="flex items-center gap-2 border-border/30 border-y bg-bg-accent/40 px-2 py-0.5 text-muted/50 text-2xs">
      <span className="select-none">&ctdot;</span>
      <span className="select-none tabular-nums">
        {hidden} unchanged {hidden === 1 ? "line" : "lines"}
      </span>
    </div>
  );
}

/**
 * Render an edit as an interleaved diff. When `oldText` is omitted (a file
 * write rather than an edit) every line is shown as an addition. Long runs of
 * unchanged context are folded to a quiet "⋯ N unchanged" divider.
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

  const view = foldContext(rows);

  return (
    <div
      className="overflow-x-hidden overflow-y-auto rounded-sm border border-border/40 bg-bg-accent font-mono text-2xs leading-snug"
      style={{ maxHeight: "18rem" }}
      data-testid="orchestrator-diff"
    >
      {view.map((row) =>
        row.type === "fold" ? (
          <FoldDivider key={row.key} hidden={row.hidden} />
        ) : (
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
        ),
      )}
    </div>
  );
}
