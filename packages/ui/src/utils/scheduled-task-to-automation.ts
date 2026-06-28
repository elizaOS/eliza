/**
 * Adapter: LifeOps `ScheduledTaskView` → `AutomationItem`.
 *
 * Pure mapping so the unified Tasks surface can render boot-seeded scheduled
 * tasks (gm / gn / daily check-in / morning-brief watcher + the PAUSED
 * weekly-review recap) in the SAME row format as workflows and workbench
 * tasks, without any backend merge. This is read-only surfacing — it never
 * writes, schedules, or runs anything.
 *
 * Correctness invariants (see the unification design):
 *  - A `manual` trigger maps to status `"paused"` / not-enabled so the seeded
 *    weekly-review shows as a non-firing starter, never "active".
 *  - `default_pack` / `first_run` tasks are surfaced as owner-visible USER
 *    rows (`system: false`) so the owner can open and pause them — they are
 *    NOT hidden under the system bucket.
 *  - Schedule labels are computed HERE (no `new Date()` / `Date.now()` in the
 *    component render path).
 *  - The id is prefixed `scheduled:` so it never collides with `task:` /
 *    `workflow:` ids.
 */

import type {
  AutomationItem,
  AutomationStatus,
} from "../api/client-types-config";
import type {
  ScheduledTaskTriggerView,
  ScheduledTaskView,
  TriggerSummary,
} from "../api/client-types-core";
import { formatSchedule } from "./cron-format";

/** Terminal scheduled-task states — the row is done, not running. */
const TERMINAL_STATUSES = new Set([
  "completed",
  "skipped",
  "expired",
  "failed",
  "dismissed",
]);

/**
 * Friendly title for a scheduled task. Default-pack records carry a stable
 * `metadata.recordKey`; everything else derives a label from `kind`. Never
 * surfaces `promptInstructions` as the title (that is the description).
 */
export function scheduledTaskTitle(task: ScheduledTaskView): string {
  const recordKey =
    typeof task.metadata?.recordKey === "string"
      ? task.metadata.recordKey
      : null;
  switch (recordKey) {
    case "gm":
      return "Good morning";
    case "gn":
      return "Good night";
    case "checkin":
      return "Daily check-in";
    case "checkin-followup":
      return "Check-in follow-up";
    case "weekly-review":
      return "Weekly review";
    default:
      break;
  }
  const slot =
    typeof task.metadata?.slot === "string" ? task.metadata.slot : null;
  if (slot) return slot;
  switch (task.kind) {
    case "reminder":
      return "Reminder";
    case "checkin":
      return "Check-in";
    case "followup":
      return "Follow-up";
    case "approval":
      return "Approval";
    case "recap":
      return "Recap";
    case "watcher":
      return "Watcher";
    case "output":
      return "Output";
    default:
      return "Scheduled task";
  }
}

/**
 * Human schedule label for a scheduled-task trigger. Computed at adapt time so
 * the render path stays clock-free.
 */
export function scheduledTaskScheduleLabel(
  trigger: ScheduledTaskTriggerView,
): string | null {
  switch (trigger.kind) {
    case "cron":
      return formatSchedule(trigger.expression);
    case "interval":
      return `Every ${trigger.everyMinutes} min`;
    case "once":
      return "Once";
    case "relative_to_anchor":
      return `On ${trigger.anchorKey}`;
    case "during_window":
      return `During ${trigger.windowKey}`;
    case "event":
      return `On ${trigger.eventKind}`;
    case "after_task":
      return "After another task";
    case "manual":
      return "Manual";
    default:
      return null;
  }
}

/**
 * Map a scheduled-task status + trigger to an `AutomationStatus`.
 *  - manual trigger → "paused" (non-firing starter, e.g. weekly-review)
 *  - terminal state → "completed"
 *  - otherwise → "active"
 */
function deriveStatus(task: ScheduledTaskView): AutomationStatus {
  if (TERMINAL_STATUSES.has(task.state.status)) return "completed";
  if (task.trigger.kind === "manual") return "paused";
  return "active";
}

function buildScheduleSummary(task: ScheduledTaskView): TriggerSummary[] {
  const label = scheduledTaskScheduleLabel(task.trigger);
  if (!label) return [];
  const id = `scheduled:${task.taskId}`;
  const cronExpression =
    task.trigger.kind === "cron" ? task.trigger.expression : undefined;
  return [
    {
      id,
      taskId: task.taskId,
      // `displayName` is the schedule label the feed renders directly when no
      // `cronExpression` is present.
      displayName: label,
      instructions: task.promptInstructions,
      triggerType: cronExpression ? "cron" : "event",
      enabled: task.trigger.kind !== "manual",
      wakeMode: "inject_now",
      createdBy: task.createdBy,
      cronExpression,
      runCount: 0,
    },
  ];
}

export function scheduledTaskToAutomationItem(
  task: ScheduledTaskView,
): AutomationItem {
  const status = deriveStatus(task);
  const enabled = task.trigger.kind !== "manual" && status !== "completed";
  return {
    id: `scheduled:${task.taskId}`,
    type: "coordinator_text",
    source: "scheduled_task",
    title: scheduledTaskTitle(task),
    description: task.promptInstructions,
    status,
    enabled,
    // Surface as an owner-visible user row, never the system bucket, so the
    // seeded defaults are listed and editable.
    system: false,
    isDraft: false,
    hasBackingWorkflow: false,
    updatedAt: task.state.completedAt ?? task.state.firedAt ?? null,
    taskId: task.taskId,
    scheduledTask: task,
    schedules: buildScheduleSummary(task),
  };
}
