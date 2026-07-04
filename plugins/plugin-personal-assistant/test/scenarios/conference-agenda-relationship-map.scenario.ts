import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

/**
 * Live-model conference agenda + relationship-map flow. Seeds real meeting
 * requests — a high-value ask from "Vantorre
 * Capital" (owed a follow-up) and a low-priority booth ask from the "Quenby
 * Group" — that appear in no user turn, so the ranking and the
 * accept/decline/delegate buckets are grounded in seeded state rather than
 * parroted (#9310). Declines stay held
 * for approval and nothing may be dispatched.
 */
export default scenario({
  lane: "live-only",
  id: "conference-agenda-relationship-map",
  title:
    "Conference meeting map ranks the seeded high-value request above the seeded booth ask",
  domain: "executive.schedule",
  tags: [
    "lifeops",
    "executive-assistant",
    "calendar",
    "relationships",
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
      title: "LifeOps Conference Agenda Relationship Map",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed high-value meeting request",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title:
          "Conference meeting request from Vantorre Capital — high relationship value, we owe them a follow-up",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+2w}}",
          visibilityLeadMinutes: 43200,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed low-priority booth ask",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Low-priority conference ask from the Quenby Group booth team",
        timezone: "UTC",
        priority: 4,
        cadence: {
          kind: "once",
          dueAt: "{{now+2w}}",
          visibilityLeadMinutes: 43200,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "rank-conference-meetings",
      room: "main",
      text: "For the conference next month, rank the meeting requests we're already tracking by relationship value, travel friction, and whether I owe them a follow-up.",
      plannerExcludes: ["OWNER_HEALTH"],
      // Grounding outcome: the ranking must surface the seeded high-value
      // request — it appears in no user turn, so an echo cannot pass.
      responseIncludesAll: ["vantorre"],
      responseIncludesAny: ["quenby"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The ranking must place the seeded high-value request (the firm we owe a follow-up) above the seeded low-priority booth ask, with the relationship-value rationale stated. Ranking the booth ask first, or omitting the seeded requests, fails.",
      },
    },
    {
      kind: "message",
      name: "draft-meeting-plan",
      room: "main",
      text: "Draft a meeting plan with accept, decline, and delegate buckets. Ask before sending any declines.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseIncludesAny: ["vantorre", "quenby"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The plan must place the seeded requests into concrete buckets — the high-value firm accepted, the booth ask declined or delegated — and make explicit that no decline is sent before the owner approves. Vague buckets that never place the seeded requests fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title:
        "Conference meeting request from Vantorre Capital — high relationship value, we owe them a follow-up",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Low-priority conference ask from the Quenby Group booth team",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "custom",
      name: "meeting-plan-no-declines-sent",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "relationship-map-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the ranking put the seeded owed-follow-up request above the seeded booth ask, the plan bucketed both concretely, and declines were held for the owner's approval.",
    },
  ],
});
