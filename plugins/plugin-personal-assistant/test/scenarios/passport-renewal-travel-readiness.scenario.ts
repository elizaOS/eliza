import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

/**
 * Live-model scenario (live-only lane): Travel readiness audit grounds in seeded trip state; coordinator note stays staged.
 */
export default scenario({
  lane: "live-only",
  id: "passport-renewal-travel-readiness",
  title:
    "Travel readiness audit grounds in seeded trip state; coordinator note stays staged",
  domain: "executive.travel",
  tags: [
    "lifeops",
    "executive-assistant",
    "travel",
    "documents",
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
      title: "LifeOps Passport Renewal Travel Readiness",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed trip block: Merlion Summit",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Singapore trip — Merlion Summit meeting block",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+5d}}",
          visibilityLeadMinutes: 20160,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed travel coordinator: Isla Renwick",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Travel coordinator — Isla Renwick, renewal escalation contact",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+3d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "audit-passport-risk",
      room: "main",
      text: "Before the Singapore trip, check whether my passport, visa, calendar holds, and hotel details are safe. Flag anything that could block boarding.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "CALENDAR", "travel"],
      plannerExcludes: ["OWNER_HEALTH"],
      // Grounding outcome: the audit must surface the seeded trip state —
      // neither token appears in any user turn.
      responseIncludesAny: ["merlion", "renwick"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The readiness audit must be grounded in the seeded trip state — the Merlion Summit meeting block and the coordinator Isla Renwick — and flag concrete boarding blockers (passport validity window, visa status). A generic travel checklist that names neither seeded item fails.",
      },
    },
    {
      kind: "message",
      name: "build-renewal-plan",
      room: "main",
      text: "If the passport window is risky, create the renewal task list and draft the note to the travel coordinator.",
      plannerIncludesAny: ["SCHEDULED_TASKS", "owner_send_message", "renewal"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      // The renewal plan must target the seeded coordinator and trip.
      responseIncludesAny: ["renwick", "merlion"],
      responseExcludes: ["i've sent", "i have sent", "already sent"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must build a concrete renewal task list tied to the seeded trip timing and stage a note addressed to the seeded coordinator Isla Renwick. Claiming the note was already sent fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded trip state the audit was graded against persisted.
    {
      type: "definitionCountDelta",
      title: "Singapore trip — Merlion Summit meeting block",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Travel coordinator — Isla Renwick, renewal escalation contact",
      delta: 1,
      cadenceKind: "once",
    },
    // NEGATIVE OUTCOME: the coordinator note stayed staged, never sent.
    {
      type: "custom",
      name: "coordinator-note-not-dispatched",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "travel-readiness-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the boarding-risk audit was grounded in the seeded Merlion Summit trip and Renwick coordinator contact, the renewal task list was built against the trip timing, and the coordinator note stayed a staged draft with nothing dispatched externally.",
    },
  ],
});
