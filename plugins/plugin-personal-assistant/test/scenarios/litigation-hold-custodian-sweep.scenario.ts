import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

/**
 * Live-model scenario (live-only lane): Litigation hold sweep grounds in seeded custodian state; follow-ups stay staged.
 */
export default scenario({
  lane: "live-only",
  id: "litigation-hold-custodian-sweep",
  title:
    "Litigation hold sweep grounds in seeded custodian state; follow-ups stay staged",
  domain: "executive.legal",
  tags: [
    "lifeops",
    "executive-assistant",
    "legal",
    "documents",
    "privacy",
    "outcome",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Litigation Hold Custodian Sweep",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed hold matter: Danvers custodian list",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Litigation hold — Danvers matter custodian list",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+2d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed unacknowledged custodian: Tomas Lindqvist",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Hold acknowledgement missing — custodian Tomas Lindqvist",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+1d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "map-custodians-and-sources",
      room: "main",
      text: "Outside counsel sent a litigation hold. Map likely custodians, shared drives, calendar ranges, messaging threads, and missing acknowledgements without opening privileged attachments.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "privacy", "delegation"],
      plannerExcludes: ["OWNER_HEALTH"],
      // Grounding outcome: the sweep must surface the seeded hold state —
      // neither token appears in any user turn.
      responseIncludesAny: ["danvers", "lindqvist"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The sweep must be grounded in the seeded hold state — the Danvers-matter custodian list and the unacknowledged custodian Tomas Lindqvist — while explicitly avoiding privileged attachments. A generic litigation-hold checklist that names neither seeded item fails.",
      },
    },
    {
      kind: "message",
      name: "draft-hold-followups",
      room: "main",
      text: "Draft follow-ups for custodians who have not acknowledged and schedule a counsel check-in tomorrow. Do not send without my approval.",
      plannerIncludesAny: ["owner_send_message", "calendar_action", "approval"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      // The follow-up must target the seeded unacknowledged custodian.
      responseIncludesAny: ["lindqvist"],
      responseExcludes: ["i've sent", "i have sent", "already sent"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must stage a follow-up for the seeded unacknowledged custodian Lindqvist, schedule a counsel check-in for tomorrow, and hold every send for the owner's approval. Claiming a follow-up was already sent fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded hold state the sweep was graded against persisted.
    {
      type: "definitionCountDelta",
      title: "Litigation hold — Danvers matter custodian list",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Hold acknowledgement missing — custodian Tomas Lindqvist",
      delta: 1,
      cadenceKind: "once",
    },
    // NEGATIVE OUTCOME: the follow-ups stayed staged, never sent.
    {
      type: "custom",
      name: "hold-followups-not-dispatched",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "litigation-hold-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the custodian sweep was grounded in the seeded Danvers matter and the missing Lindqvist acknowledgement, follow-ups and the counsel check-in were staged, and nothing was sent without approval.",
    },
  ],
});
