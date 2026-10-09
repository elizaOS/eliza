/** Deadline projection for the existing LifeOps task, not another timer/queue. */

import type {
  LifeOpsCalendarEvent,
  LifeOpsOccurrence,
  LifeOpsReminderAttempt,
  LifeOpsReminderPlan,
} from "@elizaos/contracts";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { LIFEOPS_TASK_NAME, LIFEOPS_TASK_TAGS } from "./scheduler-task.js";

export function nextReminderWakeAt(
  occurrences: Pick<
    LifeOpsOccurrence,
    "id" | "definitionId" | "state" | "snoozedUntil" | "relevanceStartAt"
  >[],
  plans: LifeOpsReminderPlan[],
  attempts: LifeOpsReminderAttempt[],
  now: number,
  events: Pick<
    LifeOpsCalendarEvent,
    "id" | "startAt" | "endAt" | "status"
  >[] = [],
  eventPlans: LifeOpsReminderPlan[] = [],
): number | undefined {
  let earliest = Infinity;
  const delivered = new Set(
    attempts
      .filter((a) =>
        ["delivered", "delivered_read", "delivered_unread"].includes(a.outcome),
      )
      .map((a) =>
        JSON.stringify([
          a.ownerType,
          a.ownerId,
          a.planId,
          a.stepIndex,
          a.channel,
          Date.parse(a.scheduledFor),
        ]),
      ),
  );
  const byOwner = new Map(plans.map((p) => [p.ownerId, p]));
  const calendarPlans = new Map(eventPlans.map((p) => [p.ownerId, p]));
  const consider = (
    ownerType: "occurrence" | "calendar_event",
    ownerId: string,
    plan: LifeOpsReminderPlan | undefined,
    anchor: number,
    sign: number,
  ) => {
    if (!plan) return;
    for (const [stepIndex, step] of plan.steps.entries()) {
      const at = anchor + sign * step.offsetMinutes * 60000;
      if (
        !Number.isSafeInteger(at) ||
        at <= now ||
        delivered.has(
          JSON.stringify([
            ownerType,
            ownerId,
            plan.id,
            stepIndex,
            step.channel,
            at,
          ]),
        )
      )
        continue;
      earliest = Math.min(earliest, at);
    }
  };
  for (const occurrence of occurrences) {
    if (["completed", "skipped", "expired", "muted"].includes(occurrence.state))
      continue;
    consider(
      "occurrence",
      occurrence.id,
      byOwner.get(occurrence.definitionId),
      Date.parse(occurrence.snoozedUntil ?? occurrence.relevanceStartAt),
      1,
    );
  }
  for (const event of events) {
    if (event.status === "cancelled" || Date.parse(event.endAt) <= now)
      continue;
    consider(
      "calendar_event",
      event.id,
      calendarPlans.get(event.id),
      Date.parse(event.startAt),
      -1,
    );
  }
  return Number.isFinite(earliest) ? earliest : undefined;
}

/** Domain writes already committed. Wake diagnostics cannot relabel their effect;
 * unsupported adapters retain the existing maintenance cadence explicitly. */
export async function requestReminderWake(
  runtime: IAgentRuntime,
  at: number | undefined,
): Promise<void> {
  if (at === undefined) return;
  try {
    if (runtime.adapter?.supportsAtomicTaskWake !== true)
      throw new ElizaError(
        "Reminder deadline wake unavailable; retaining maintenance cadence",
        { code: "TASK_WAKE_UNSUPPORTED" },
      );
    const tasks = await runtime.getTasks({
      agentIds: [runtime.agentId],
      tags: [...LIFEOPS_TASK_TAGS],
    });
    const task = tasks.find((t) => t.name === LIFEOPS_TASK_NAME);
    if (!task?.id)
      throw new ElizaError(
        "Reminder scheduler row missing; maintenance bootstrap will reconcile",
        { code: "TASK_WAKE_MISSING" },
      );
    const outcome = await runtime.patchTaskMetadata(task.id, {
      wake: { requestAt: at },
    });
    if (outcome !== "patched")
      throw new ElizaError("Reminder wake was not committed", {
        code: "TASK_WAKE_UNSUPPORTED",
        context: { outcome },
      });
  } catch (error) {
    // error-policy:J7 The domain mutation is authoritative; base cadence/restart
    // reconciliation recovers a missed wake and the diagnostic stays visible.
    runtime.reportError("LifeOps.requestReminderWake", error, {
      diagnosticOnly: true,
      requestedAt: at,
    });
  }
}
