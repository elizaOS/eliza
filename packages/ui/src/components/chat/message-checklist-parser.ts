/**
 * Parser for `[CHECKLIST]\n{...json...}\n[/CHECKLIST]` blocks an agent emits to
 * render a todo/checklist inline (issue #13536 §todos). Mirrors
 * `message-form-parser.ts`. Re-parsing on every message update is what lets a
 * re-emitted block mutate the checklist in place. Coding-task todos flow through
 * the live `plan` event instead (see `task-activity-store` / the task card); this
 * marker is for a standalone agent checklist not tied to an orchestrator task.
 *
 * Body shape:
 *   {
 *     "title"?: string,
 *     "items": [
 *       { "content": string, "status"?: "pending"|"in_progress"|"completed" }
 *     ]
 *   }
 *
 * Normalizes into the shared `SwarmActivityPlanEntry[]` so it renders through the
 * same `PlanChecklist` component the live task pipeline uses.
 */

import type { SwarmActivityPlanEntry } from "@elizaos/core";

/** Hard cap so a runaway agent can't render an unbounded checklist. */
export const MAX_CHECKLIST_ITEMS = 40;

const ITEM_STATUSES = new Set(["pending", "in_progress", "completed"]);

export const CHECKLIST_RE = /\[CHECKLIST\]\n([\s\S]*?)\n\[\/CHECKLIST\]/g;

export interface ChecklistSpec {
  title?: string;
  items: SwarmActivityPlanEntry[];
}

function parseItem(raw: unknown): SwarmActivityPlanEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const content = record.content;
  if (typeof content !== "string" || content.trim().length === 0) return null;
  const status =
    typeof record.status === "string" && ITEM_STATUSES.has(record.status)
      ? record.status
      : "pending";
  return { content: content.trim(), status };
}

/** Parse a `[CHECKLIST]` body into a normalized spec, or `null` if malformed. */
export function parseChecklistBody(body: string): ChecklistSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // error-policy:J3 untrusted model output — null is the explicit "malformed"
    // signal so the block falls back to rendering as plain text.
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.items)) return null;

  const items: SwarmActivityPlanEntry[] = [];
  for (const rawItem of record.items) {
    if (items.length >= MAX_CHECKLIST_ITEMS) break;
    const item = parseItem(rawItem);
    if (item) items.push(item);
  }
  if (items.length === 0) return null;

  return {
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    items,
  };
}

export interface ChecklistMatch {
  start: number;
  end: number;
  checklist: ChecklistSpec;
}

/** Find every CHECKLIST block in `text` and return their character regions. */
export function findChecklistRegions(text: string): ChecklistMatch[] {
  const results: ChecklistMatch[] = [];
  CHECKLIST_RE.lastIndex = 0;
  let m: RegExpExecArray | null = CHECKLIST_RE.exec(text);
  while (m !== null) {
    const checklist = parseChecklistBody(m[1]);
    if (checklist) {
      results.push({ start: m.index, end: m.index + m[0].length, checklist });
    }
    m = CHECKLIST_RE.exec(text);
  }
  return results;
}
