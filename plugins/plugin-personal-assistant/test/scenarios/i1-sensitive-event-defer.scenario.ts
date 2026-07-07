/**
 * I1 sensitive-event deferral. A negative sentiment edge and delayed owner
 * check-in are structural state; the assistant does not turn a heated rupture
 * into automatic outreach or counseling.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "i1-sensitive-event-defer",
  title: "I1 negative rupture sentiment schedules owner check-in only",
  domain: "lifeops.relationships",
  tags: ["lifeops", "I1", "sentiment", "followup", "relationships"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "I1 Sensitive Event Defer",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "capture-negative-sentiment",
      room: "main",
      actionName: "ENTITY",
      text: "Capture that the Priya disagreement is a negative relationship event for now.",
      options: {
        action: "set_relationship",
        fromEntityId: "self",
        toEntityId: "person-i1-priya",
        relationshipType: "friend_of",
        evidence:
          "owner reported heated disagreement and wants time before outreach",
        metadata: {
          sentimentTrend: "negative",
        },
      },
    },
    {
      kind: "action",
      name: "schedule-owner-checkin",
      room: "main",
      actionName: "SCHEDULED_TASKS",
      text: "In three days, remind only me to decide whether I want to repair the Priya thread.",
      options: {
        action: "create",
        kind: "followup",
        subjectKind: "relationship",
        subjectId: "rel-i1-priya",
        priority: "low",
        promptInstructions:
          "Ask the owner whether they want to repair the Priya thread; do not contact Priya automatically.",
        trigger: {
          kind: "once",
          runAt: "2026-07-09T12:00:00.000Z",
        },
        completionCheck: {
          kind: "subject_updated",
          followupAfterMinutes: 0,
        },
        metadata: {
          pack: "I1",
          sentimentTrend: "negative",
          ownerOnly: true,
        },
        idempotencyKey: "i1-priya-sensitive-event-checkin",
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "ENTITY",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "SCHEDULED_TASKS",
      status: "success",
      minCount: 1,
    },
    {
      type: "selectedActionArguments",
      actionName: ["ENTITY", "SCHEDULED_TASKS"],
      includesAll: ["sentimentTrend", "negative", "ownerOnly", "rel-i1-priya"],
    },
    {
      type: "custom",
      name: "no delivered external send",
      predicate: expectNoExternalSendDispatch(),
    },
  ],
});
