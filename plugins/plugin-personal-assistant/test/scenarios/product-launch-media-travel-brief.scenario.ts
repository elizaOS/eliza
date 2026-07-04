// Defines the product launch media travel brief LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

/**
 * Live-model scenario (live-only lane): Launch brief grounds in the seeded flight and keeps investor and press drafts separated.
 */
export default scenario({
  lane: "live-only",
  id: "product-launch-media-travel-brief",
  title:
    "Launch brief grounds in the seeded flight and keeps investor and press drafts separated",
  domain: "executive.briefing",
  tags: ["lifeops", "executive-assistant", "travel", "briefing", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Product Launch Media Travel Brief",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed launch flight VK218",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Launch trip flight — VK218 to Berlin press day",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+5d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed private investor touchpoint",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Investor touchpoint — Northcliff Capital dinner (private)",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+5d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "assemble-launch-brief",
      room: "main",
      text: "For next week's launch trip, assemble a brief from what we're tracking: flight risk, press slots, investor touchpoints, venue arrival windows, and the two talking points I should avoid.",
      plannerExcludes: ["OWNER_HEALTH"],
      // Grounding outcome: the brief must surface the seeded flight — "vk218"
      // appears in no user turn, so an echo cannot pass.
      responseIncludesAll: ["vk218"],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The brief must be grounded in the seeded trip state (flight VK218 to the Berlin press day and the Northcliff Capital investor dinner) and organize flight risk, press slots, arrival windows, and an avoid-list. A generic launch checklist ignoring the tracked trip fails.",
      },
    },
    {
      kind: "message",
      name: "stage-stakeholder-updates",
      room: "main",
      text: "Draft a private investor update and a separate media prep note. Keep the investor version out of the press thread.",
      plannerExcludes: ["send_to_agent"],
      // Grounding outcome: the investor update must reference the seeded
      // investor — "northcliff" appears in no user turn.
      responseIncludesAll: ["northcliff"],
      responseExcludes: ["already sent", "i've sent", "i have sent"],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The reply must stage two clearly separated drafts: a private investor update referencing the seeded Northcliff Capital touchpoint, and a media prep note that contains no investor-only material. Mixing the audiences or claiming either draft was sent fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded trip state the brief was graded against persisted.
    {
      type: "definitionCountDelta",
      title: "Launch trip flight — VK218 to Berlin press day",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Investor touchpoint — Northcliff Capital dinner (private)",
      delta: 1,
      cadenceKind: "once",
    },
    // NEGATIVE OUTCOME: drafts only — nothing went to press or investors.
    {
      type: "custom",
      name: "launch-brief-draft-gate-held",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "launch-brief-end-to-end",
      minimumScore: 0.6,
      rubric:
        "End-to-end: the launch brief was grounded in the seeded VK218 flight and Northcliff dinner, and the investor/media drafts stayed separated and unsent.",
    },
  ],
});
