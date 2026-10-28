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

/** The not-run settlement of a finished execution, or null for any execution that ran. */
export function workflowRunNotRun(
  execution: Pick<WorkflowExecution, "status" | "finished" | "output">,
  formatTime: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): WorkflowRunNotRun | null {
  if (!execution.finished || execution.status !== "finished") return null;
  const settled = workflowOccurrenceNotRun(execution.output);
  if (!settled) return null;
  const when = formatTime(settled.scheduledAt);
  return settled.status === "missed"
    ? {
        status: "missed",
        label: "Missed — did not run",
        notice: `Scheduled for ${when}. The agent was not running then, so nothing ran. It is not run later; use Run now to start it once.`,
        offerRunNow: true,
      }
    : {
        status: "overlap",
        label: "Skipped — an earlier run was still active",
        notice: `Scheduled for ${when}. An earlier run was still active, so nothing ran for this time.`,
        offerRunNow: false,
      };
}
