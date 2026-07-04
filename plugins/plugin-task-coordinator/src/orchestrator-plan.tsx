// Renders the live orchestrator plan checklist.
import { Button } from "@elizaos/ui/components/ui/button";
import { Check, ChevronRight, Circle, Loader } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

// The orchestrator's current plan checklist. The sub-agent (opencode) emits its
// checklist snapshot as an ACP `plan` update; the backend sanitizes it onto the
// task's `currentPlan`, and this dock renders it the way Codex/Claude/opencode
// surface a live checklist: a pinned, collapsible panel with per-item status
// (pending / in-progress / done) and a progress count. Color is meaning-only —
// green = done, neutral spinner = in-progress, muted = pending; no accent fill.

interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** Narrow the loosely-typed `currentPlan` DTO (Record<string, unknown>) into the
 * typed entries this view renders, dropping anything malformed. */
function readEntries(plan: Record<string, unknown>): PlanEntry[] {
  const raw = plan.entries;
  if (!Array.isArray(raw)) return [];
  const entries: PlanEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content : "";
    if (content === "") continue;
    const status =
      record.status === "in_progress" || record.status === "completed"
        ? record.status
        : "pending";
    entries.push({ content, status });
  }
  return entries;
}

function StatusIcon({ status }: { status: PlanEntry["status"] }): ReactNode {
  if (status === "completed")
    return <Check className="h-3 w-3 shrink-0 text-ok" aria-hidden />;
  if (status === "in_progress")
    return (
      <Loader
        className="h-3 w-3 shrink-0 animate-spin text-muted-strong"
        aria-hidden
      />
    );
  return <Circle className="h-3 w-3 shrink-0 text-muted/60" aria-hidden />;
}

export function PlanDock({
  plan,
}: {
  plan: Record<string, unknown>;
}): ReactNode {
  const entries = readEntries(plan);
  // The agent has just begun in-progress items first by default, so opening the
  // dock once there's an active step keeps the live work visible.
  const hasActive = entries.some((entry) => entry.status === "in_progress");
  const [open, setOpen] = useState(hasActive);
  // A plan can start all-pending (collapsed) and then gain an in-progress
  // step; the lazy init above runs once at mount, so reopen on the false→true
  // transition. Only forces open (never re-collapses), preserving manual toggle.
  useEffect(() => {
    if (hasActive) setOpen(true);
  }, [hasActive]);
  if (entries.length === 0) return null;
  const done = entries.filter((entry) => entry.status === "completed").length;

  return (
    <div
      className="rounded-md border border-border/50 bg-card/40"
      data-testid="orchestrator-plan"
    >
      <Button
        unstyled
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-xs font-semibold text-txt">Plan</span>
        <span className="flex-1" />
        <span className="font-mono text-2xs tabular-nums text-muted">
          {done}/{entries.length}
        </span>
      </Button>
      {open ? (
        <ul className="space-y-0.5 px-2.5 pb-2">
          {entries.map((entry, index) => (
            <li
              // Plan entries have no stable id and may repeat content across a
              // single immutable snapshot; position is the only discriminator.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional plan snapshot
              key={`${entry.content}-${index}`}
              className="flex items-start gap-2 text-xs-tight"
            >
              <span className="mt-0.5">
                <StatusIcon status={entry.status} />
              </span>
              <span
                className={
                  entry.status === "completed"
                    ? "text-muted line-through"
                    : entry.status === "in_progress"
                      ? "text-txt"
                      : "text-muted-strong"
                }
              >
                {entry.content}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
