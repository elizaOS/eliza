/**
 * G2 cadence watcher coverage over the shared ScheduledTask spine. A stale
 * relationship edge is represented as a relationship-scoped follow-up task; the
 * list step proves downstream code reads structural fields, not prompt text.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

function resultData(
  action: ScenarioContext["actionsCalled"][number],
): Record<string, unknown> | null {
  const data = action.result?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return null;
}

function expectStaleEdgeFollowup() {
  return (ctx: ScenarioContext): string | undefined => {
    const created = ctx.actionsCalled.find((action) => {
      if (
        action.actionName !== "SCHEDULED_TASKS" ||
        resultData(action)?.subaction !== "create"
      ) {
        return false;
      }
      const task = resultData(action)?.task;
      if (!task || typeof task !== "object" || Array.isArray(task)) {
        return false;
      }
      const record = task as Record<string, unknown>;
      const subject = record.subject as Record<string, unknown> | undefined;
      return (
        record.kind === "followup" &&
        subject?.kind === "relationship" &&
        subject.id === "rel-g2-zane"
      );
    });
    if (!created) {
      return "expected relationship-scoped followup for rel-g2-zane";
    }
    const listed = ctx.actionsCalled.find(
      (action) =>
        action.actionName === "SCHEDULED_TASKS" &&
        resultData(action)?.subaction === "list" &&
        action.result?.success === true,
    );
    if (!listed) {
      return "expected overdue followup list after stale-edge creation";
    }
    return undefined;
  };
}

export default scenario({
  lane: "live-only",
  id: "g2-cadence-watcher-due",
  title:
    "G2 cadence watcher emits a relationship follow-up for stale friend edge",
  domain: "lifeops.relationships",
  tags: ["lifeops", "G2", "followup", "scheduled-task", "relationships"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "G2 Cadence Watcher",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "create-stale-edge-followup",
      room: "main",
      actionName: "SCHEDULED_TASKS",
      text: "Create a stale relationship follow-up for Zane.",
      options: {
        action: "create",
        kind: "followup",
        subjectKind: "relationship",
        subjectId: "rel-g2-zane",
        priority: "medium",
        promptInstructions:
          "Reconnect with Zane after a stale eight-month relationship cadence gap.",
        trigger: {
          kind: "once",
          runAt: "2025-11-06T00:00:00.000Z",
        },
        completionCheck: {
          kind: "subject_updated",
          followupAfterMinutes: 0,
        },
        metadata: {
          pack: "G2",
          cadenceDays: 180,
          lastInteractionIso: "2025-11-06T00:00:00.000Z",
        },
        idempotencyKey: "g2-zane-stale-edge-followup",
      },
    },
    {
      kind: "action",
      name: "list-overdue-relationship-followups",
      room: "main",
      actionName: "SCHEDULED_TASKS",
      text: "List overdue relationship follow-ups.",
      options: {
        action: "list",
        kind: "followup",
        subjectKind: "relationship",
        dueWindow: "overdue",
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "SCHEDULED_TASKS",
      status: "success",
      minCount: 2,
    },
    {
      type: "custom",
      name: "stale edge followup created and listed",
      predicate: expectStaleEdgeFollowup(),
    },
    {
      type: "selectedActionArguments",
      actionName: "SCHEDULED_TASKS",
      includesAll: ["followup", "relationship", "rel-g2-zane", "cadenceDays"],
    },
  ],
});
