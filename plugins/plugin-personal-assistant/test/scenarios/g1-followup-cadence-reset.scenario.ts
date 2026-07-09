/**
 * G1 follow-up cadence scenario over the canonical ScheduledTask spine. It
 * creates a relationship-scoped follow-up and then lists overdue follow-ups,
 * proving the pack uses structural task fields instead of prompt text to model
 * overdue communication cadence.
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

function expectRelationshipFollowupCreatedAndListed() {
  return (ctx: ScenarioContext): string | undefined => {
    const creates = ctx.actionsCalled.filter(
      (action) =>
        action.actionName === "SCHEDULED_TASKS" &&
        resultData(action)?.subaction === "create",
    );
    const created = creates.find((action) => {
      const task = resultData(action)?.task;
      if (!task || typeof task !== "object" || Array.isArray(task)) {
        return false;
      }
      const record = task as Record<string, unknown>;
      const subject = record.subject;
      return (
        record.kind === "followup" &&
        subject &&
        typeof subject === "object" &&
        !Array.isArray(subject) &&
        (subject as Record<string, unknown>).kind === "relationship"
      );
    });
    if (!created) {
      return "expected SCHEDULED_TASKS create to return a relationship-scoped followup task";
    }
    const listed = ctx.actionsCalled.find(
      (action) =>
        action.actionName === "SCHEDULED_TASKS" &&
        resultData(action)?.subaction === "list" &&
        action.result?.success === true,
    );
    if (!listed) {
      return "expected SCHEDULED_TASKS list to return successfully after creating the followup";
    }
    return undefined;
  };
}

export default scenario({
  lane: "pr-deterministic",
  id: "g1-followup-cadence-reset",
  title: "G1 overdue communication cadence uses relationship follow-up tasks",
  domain: "lifeops.relationships",
  tags: ["lifeops", "G1", "followup", "scheduled-task", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "G1 Follow-up Cadence",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "create-overdue-relationship-followup",
      room: "main",
      actionName: "SCHEDULED_TASKS",
      text: "Track an overdue reply follow-up for the Mira relationship thread.",
      options: {
        parameters: {
          action: "create",
          kind: "followup",
          subjectKind: "relationship",
          subjectId: "rel-g1-mira",
          priority: "high",
          promptInstructions:
            "Follow up with Mira about the overdue reply after the owner approves a concise repair draft.",
          trigger: {
            kind: "once",
            atIso: "2026-06-14T00:00:00.000Z",
          },
          completionCheck: {
            kind: "subject_updated",
            followupAfterMinutes: 1,
          },
          metadata: {
            pack: "G1",
            relationship: "Mira",
            cadenceDays: 14,
          },
          idempotencyKey: "g1-overdue-comms-mira-followup",
        },
      },
      assertResponse(text: string) {
        if (!/scheduled|already scheduled/i.test(text)) {
          return "relationship follow-up create did not acknowledge the scheduled task";
        }
      },
    },
    {
      kind: "action",
      name: "list-overdue-followups",
      room: "main",
      actionName: "SCHEDULED_TASKS",
      text: "List overdue follow-up tasks.",
      options: {
        parameters: {
          action: "list",
          kind: "followup",
          dueWindow: "overdue",
        },
      },
      assertResponse(text: string) {
        if (!/scheduled item|match/i.test(text)) {
          return "overdue follow-up list did not return the task list shape";
        }
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
      name: "relationship followup created and listed",
      predicate: expectRelationshipFollowupCreatedAndListed(),
    },
    {
      type: "selectedActionArguments",
      actionName: "SCHEDULED_TASKS",
      includesAll: ["followup", "relationship", "rel-g1-mira", "overdue"],
    },
  ],
});
