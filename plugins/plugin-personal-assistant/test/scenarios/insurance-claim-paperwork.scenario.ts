/**
 * Live-model luggage insurance-claim packet (#9310): seeds real claim inputs
 * through the LifeOps definition API (the Aerolane AL218 receipts and the
 * Concordia Assurance policy window) and asserts the packet is grounded in them,
 * tokens absent from every user turn. Seeds re-verified via definitionCountDelta;
 * the claim stays unsubmitted via a no-external-send predicate.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "insurance-claim-paperwork",
  title:
    "Luggage claim packet grounds in seeded flight and policy state; claim stays unsubmitted",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "documents", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Insurance Claim Paperwork",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed flight receipts: Aerolane AL218",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Luggage claim receipts — Aerolane flight AL218",
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
      name: "seed policy window: Concordia Assurance",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Travel policy — Concordia Assurance claim window Friday",
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
      kind: "message",
      name: "collect-claim-materials",
      room: "main",
      text: "My luggage claim is due Friday. Pull the receipts, flight info, photos, and policy details into one packet. Do not submit it yet.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "receipt"],
      plannerExcludes: ["send_to_agent", "list_agents"],
      // Grounding outcome: the packet must surface the seeded claim inputs —
      // neither token appears in any user turn.
      responseIncludesAny: ["aerolane", "concordia"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The packet must be grounded in the seeded claim inputs — the Aerolane AL218 flight receipts and the Concordia Assurance policy window — assembled as one reviewable packet that is explicitly NOT submitted. A generic claim checklist that names neither seeded item, or a claim of submission, fails.",
      },
    },
    {
      kind: "message",
      name: "draft-insurer-followup",
      room: "main",
      text: "Draft the insurer message and create a reminder to review it tomorrow afternoon.",
      plannerIncludesAll: ["SCHEDULED_TASKS"],
      plannerIncludesAny: ["draft", "insurer", "tomorrow"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      // The insurer draft must target the seeded insurer, and must not claim
      // it already went out.
      responseIncludesAny: ["concordia"],
      responseExcludes: ["i've sent", "i have sent", "already sent"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must stage an insurer message addressed to the seeded Concordia Assurance claim and set a review reminder for tomorrow afternoon. Claiming the message was already sent or the claim already submitted fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded claim inputs the packet was graded against persisted.
    {
      type: "definitionCountDelta",
      title: "Luggage claim receipts — Aerolane flight AL218",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Travel policy — Concordia Assurance claim window Friday",
      delta: 1,
      cadenceKind: "once",
    },
    // NEGATIVE OUTCOME: the claim and insurer message stayed staged.
    {
      type: "custom",
      name: "insurer-message-not-dispatched",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "luggage-claim-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the claim packet was assembled from the seeded Aerolane receipts and Concordia policy window, the insurer draft and tomorrow-afternoon review reminder were staged, and nothing was submitted or dispatched externally.",
    },
  ],
});
