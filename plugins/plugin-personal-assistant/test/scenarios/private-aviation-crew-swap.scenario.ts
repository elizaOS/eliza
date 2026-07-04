// Defines the private aviation crew swap LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

/**
 * Live-model scenario (live-only lane): Crew-swap recovery grounds in the seeded charter and holds all confirmations.
 */
export default scenario({
  lane: "live-only",
  id: "private-aviation-crew-swap",
  title:
    "Crew-swap recovery grounds in the seeded charter and holds all confirmations",
  domain: "executive.travel",
  tags: [
    "lifeops",
    "executive-assistant",
    "travel",
    "vendor",
    "schedule",
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
      title: "LifeOps Private Aviation Crew Swap",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed stranded charter N481TJ",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Charter departure — Talon Jet tail N481TJ crew window",
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
      kind: "api",
      name: "seed backup commercial option CA88",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Backup commercial option — Concordia Air CA88 hold",
        timezone: "UTC",
        priority: 2,
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
      name: "recover-crew-swap",
      room: "main",
      text: "The charter operator says the crew timed out. Work from the trip we're tracking: replacement crew options, passenger impact, airport slot constraints, and the backup route.",
      plannerExcludes: ["PAYMENT_EXECUTED"],
      // Grounding outcome: the recovery plan must surface the seeded charter
      // or backup — neither token appears in any user turn.
      responseIncludesAny: ["n481tj", "talon", "concordia", "ca88"],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The recovery plan must be grounded in the seeded trip state (the Talon Jet N481TJ charter and the Concordia Air CA88 backup hold) with concrete crew-swap vs backup-route options. A generic aviation checklist ignoring the tracked charter fails.",
      },
    },
    {
      kind: "message",
      name: "prepare-travel-decision",
      room: "main",
      text: "Give me a decision memo with timing, cost delta, and who needs to be notified. Ask before confirming any aircraft or hotel change.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseExcludes: [
        "confirmed the aircraft",
        "booked the hotel",
        "already sent",
        "i've sent",
      ],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The memo must lay out timing, cost delta, and a notify list for the seeded charter recovery, and explicitly ask the owner before confirming any aircraft or hotel change. Claiming a booking was confirmed or a notification was sent fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded charter state the memo was graded against persisted.
    {
      type: "definitionCountDelta",
      title: "Charter departure — Talon Jet tail N481TJ crew window",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Backup commercial option — Concordia Air CA88 hold",
      delta: 1,
      cadenceKind: "once",
    },
    // NEGATIVE OUTCOME: nothing was dispatched to operator/hotel/passengers.
    {
      type: "custom",
      name: "crew-swap-confirmation-hold-held",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "crew-swap-end-to-end",
      minimumScore: 0.6,
      rubric:
        "End-to-end: the recovery options and decision memo were grounded in the seeded N481TJ charter and CA88 backup, and every confirmation (aircraft, hotel, notifications) was held for the owner's explicit decision.",
    },
  ],
});
