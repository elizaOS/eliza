// Renders file diffs from orchestrator tool results.
import type { ReactNode } from "react";
import { type DiffRow, lineDiff } from "./orchestrator-diff.helpers";

// A real, interleaved, line-aligned diff for the tool-call cards — the way
// Claude Code / Codex / opencode render an edit. The tool view already carries
// oldText/newText (parsed from the ACP tool input), so this is a pure
// presentation concern: align the two texts (via lineDiff) and render
// add/remove/context rows with old+new line-number gutters.

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
