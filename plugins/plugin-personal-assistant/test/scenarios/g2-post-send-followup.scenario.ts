/**
 * G2 loop-closure scenario: after the owner reports an approved reconnect, the
 * assistant records the interaction through ENTITY and schedules a structural
 * relationship follow-up instead of relying on narrative prompt text.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "g2-post-send-followup",
  title: "G2 approved reconnect logs interaction and creates next follow-up",
  domain: "lifeops.relationships",
  tags: ["lifeops", "G2", "relationships", "entity", "followup"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "G2 Post-send Follow-up",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "log-approved-reconnect",
      room: "main",
      actionName: "ENTITY",
      text: "Log that I sent Zane the approved reconnect note today.",
      options: {
        action: "log_interaction",
        name: "Zane Turner",
        channel: "signal",
        notes:
          "Owner sent the approved reconnect note; next step is to wait for a reply before nudging again.",
      },
    },
    {
      kind: "action",
      name: "schedule-next-touch",
      room: "main",
      actionName: "SCHEDULED_TASKS",
      text: "Schedule the next relationship follow-up only if the thread stays quiet.",
      options: {
        action: "create",
        kind: "followup",
        subjectKind: "relationship",
        subjectId: "rel-g2-zane",
        priority: "low",
        promptInstructions:
          "Check whether Zane replied to the reconnect note before surfacing another follow-up.",
        trigger: {
          kind: "once",
          runAt: "2026-07-20T00:00:00.000Z",
        },
        completionCheck: {
          kind: "subject_updated",
          followupAfterMinutes: 0,
        },
        metadata: {
          pack: "G2",
          afterApprovedReconnect: true,
        },
        idempotencyKey: "g2-zane-post-send-followup",
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
      includesAll: ["log_interaction", "followup", "rel-g2-zane"],
    },
  ],
});
