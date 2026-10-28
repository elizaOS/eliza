/**
 * Presentation of a scheduled occurrence that the agent settled without running
 * anything. A missed occurrence came due while the agent was not running
 * (powered-on scheduling records it once and never replays it); an overlapping
 * one was skipped because an earlier run was still active. Both are terminal
 * `finished` executions on the agent, so the run list must not show them as
 * completed work. A missed occurrence offers an explicit, separately confirmed
 * Run now: it starts a new manual run and never replays the missed one.
 */
import { workflowOccurrenceNotRun } from "@elizaos/contracts/workflow-client";
import type { WorkflowExecution } from "../../api/client-types-chat";

export interface WorkflowRunNotRun {
  status: "missed" | "overlap";
  /** Short label for the run list and the status indicator. */
  label: string;
  /** Owner-facing statement of what happened and what did not. */
  notice: string;
  /** A new manual run may be offered (missed occurrences only). */
  offerRunNow: boolean;
}

/**
 * The not-run settlement of a finished execution, or null for any execution that ran.
 * `runNowAvailable` is false for a workflow a manual run cannot start (a hosted
 * digest is admitted only at its own scheduled occurrence): its missed time then
 * offers no Run now and says when it runs next instead.
 */
export function workflowRunNotRun(
  execution: Pick<
    WorkflowExecution,
    "status" | "finished" | "output" | "input"
  >,
  formatTime: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
  runNowAvailable = true,
): WorkflowRunNotRun | null {
  if (!execution.finished || execution.status !== "finished") return null;
  // Only the agent's own scheduled admission writes these settlements, and it
  // records the admission in the run input. A workflow whose own result merely
  // has the same shape is a run that ran.
  if (!scheduledAdmission(execution.input)) return null;
  const settled = workflowOccurrenceNotRun(execution.output);
  if (!settled) return null;
  const later = runNowAvailable
    ? "It is not run later; use Run now to start it once."
    : "It is not run later; it runs again only at its next scheduled time.";
  if (settled.status === "missed" && settled.skippedLocalTime)
    return {
      status: "missed",
      label: "Missed — did not run",
      notice: `Scheduled for ${settled.skippedLocalTime.slice(11)} on ${settled.skippedLocalTime.slice(0, 10)}, a time the clocks skipped when they moved forward, so nothing ran. ${later}`,
      offerRunNow: runNowAvailable,
    };
  const when = formatTime(settled.scheduledAt);
  return settled.status === "missed"
    ? {
        status: "missed",
        label: "Missed — did not run",
        notice: `Scheduled for ${when}. The agent was not running then, so nothing ran. ${later}`,
        offerRunNow: runNowAvailable,
      }
    : {
        status: "overlap",
        label: "Skipped — an earlier run was still active",
        notice: `Scheduled for ${when}. An earlier run was still active, so nothing ran for this time.`,
        offerRunNow: false,
      };
}

function scheduledAdmission(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return [record.typedSchedule, record.hostedDigest].some(
    (value) => !!value && typeof value === "object" && !Array.isArray(value),
  );
}

export interface TriggerRunMissed {
  /** Short label for the run list in place of the generic "Skipped". */
  label: string;
  /** Owner-facing statement that nothing ran and nothing is replayed. */
  notice: string;
}

/**
 * The missed-occurrence presentation of a trigger run record, or null for any
 * run that is not a recorded missed occurrence. Under powered-on scheduling the
 * agent persists a scheduled occurrence that came due while it was stopped as a
 * `skipped` run carrying `missedOccurrenceAt`; nothing ran for it and it is
 * never run late. The field is read structurally so older run records (and
 * agents that predate the field) keep the generic skipped presentation.
 */
export function triggerRunMissed(
  run: { status: string; missedOccurrenceAt?: unknown },
  formatTime: (epochMs: number) => string = (epochMs) =>
    new Date(epochMs).toLocaleString(),
): TriggerRunMissed | null {
  if (run.status !== "skipped") return null;
  const at = run.missedOccurrenceAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
  return {
    label: "Missed — did not run",
    notice: `Scheduled for ${formatTime(at)}. The agent was not running then, so nothing ran. It is not run later; it runs again at its next scheduled time.`,
  };
}
