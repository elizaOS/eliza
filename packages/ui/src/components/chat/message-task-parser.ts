/**
 * Parser for `[TASK:<threadId>]<title>[/TASK]` blocks emitted by orchestrator
 * actions (canonically `TASKS_CREATE`). Lives in its own module — same shape
 * as `message-choice-parser.ts` / `message-form-parser.ts` — so unit tests
 * can exercise the parsing without dragging in the `MessageContent` React
 * graph.
 *
 * The widget is rendered by `TaskWidget` (../widgets/task-widget.tsx) and
 * live-polls `/api/orchestrator/tasks/:id`. The body of the block is just
 * the task title used as the inline preview; the canonical source of truth
 * is the durable record fetched via `threadId`.
 *
 * Body shape:
 *   [TASK:<UUID-shaped threadId>]<title>[/TASK]
 *
 * Validation rules — intentionally strict because the segment runs over
 * arbitrary assistant text:
 *   - `threadId` must look like a lowercase hex/uuid (a–f0-9-, 8–64 chars)
 *     so plain prose like `[TASK: do the thing]` never triggers a widget.
 *   - `title` is bounded to 200 chars; longer titles truncate with `…`.
 *   - The block must close with `[/TASK]`; an unterminated open tag is
 *     ignored entirely (no half-rendered widget).
 */

const TASK_BLOCK_RE = /\[TASK:([a-f0-9-]{8,64})\]([\s\S]*?)\[\/TASK\]/g;

/** Hard cap on the inline preview title — keeps a runaway template safe. */
export const MAX_TASK_TITLE_LEN = 200;

export interface TaskRegion {
  start: number;
  end: number;
  threadId: string;
  title: string;
}

/**
 * Sweep `text` for `[TASK:<threadId>]<title>[/TASK]` regions. Returns each
 * matched region with its character bounds, the validated threadId, and the
 * trimmed (and bounded) title. Invalid threadIds are skipped silently so the
 * raw block becomes plain text rather than a broken widget.
 */
export function findTaskRegions(text: string): TaskRegion[] {
  if (text.length === 0) return [];

  const regions: TaskRegion[] = [];
  TASK_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null = TASK_BLOCK_RE.exec(text);
  while (match !== null) {
    const threadId = match[1];
    const rawTitle = (match[2] ?? "").trim();
    if (threadId && rawTitle) {
      const title =
        rawTitle.length > MAX_TASK_TITLE_LEN
          ? `${rawTitle.slice(0, MAX_TASK_TITLE_LEN - 1)}…`
          : rawTitle;
      regions.push({
        start: match.index,
        end: match.index + match[0].length,
        threadId,
        title,
      });
    }
    match = TASK_BLOCK_RE.exec(text);
  }
  return regions;
}
