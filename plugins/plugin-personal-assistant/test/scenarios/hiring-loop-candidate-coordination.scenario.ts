import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

/**
 * OUTCOME rewrite of the routing-only hiring-loop scenario (#9310): the old
 * file only asserted planner keywords plus reply echoes ("slots", "draft",
 * "candidate", "prep" — all present in the user's own turn text), so a
 * prompt-parroting reply passed with no interviewer state to schedule around.
 *
 * This version seeds the REAL interview panels through the LifeOps definition
 * API (the product panel with Arjen Velt and the engineering panel with Moira
 * Castellan) and asserts the coordination is GROUNDED in them: both tokens
 * never appear in any user turn, so an echo cannot pass. Seeds are
 * re-verified via definitionCountDelta and the candidate email stays staged
 * via a no-external-send predicate.
 */
export default scenario({
  lane: "live-only",
  id: "hiring-loop-candidate-coordination",
  title:
    "Hiring loop coordination grounds in seeded panels; candidate email stays staged",
  domain: "executive.hiring",
  tags: ["lifeops", "executive-assistant", "calendar", "messaging", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Hiring Loop Candidate Coordination",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed product panel: Arjen Velt",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Interview panel — product, Arjen Velt (45 min)",
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
      name: "seed engineering panel: Moira Castellan",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Interview panel — engineering, Moira Castellan (45 min)",
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
      name: "coordinate-interview-loop",
      room: "main",
      text: "Coordinate the final interview loop for Nina: find two 45-minute slots with product and engineering, draft the candidate email, and don't send yet.",
      plannerIncludesAny: ["calendar_action", "owner_send_message", "Nina"],
      plannerExcludes: ["OWNER_FINANCES"],
      // Grounding outcome: the loop plan must name the seeded interviewers —
      // neither token appears in any user turn.
      responseIncludesAny: ["velt", "castellan"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The coordination must be grounded in the seeded panels — the product slot with Arjen Velt and the engineering slot with Moira Castellan — propose two concrete 45-minute slots, and stage (not send) the candidate email. A generic scheduling reply that names neither seeded interviewer fails.",
      },
    },
    {
      kind: "message",
      name: "protect-interviewer-load",
      room: "main",
      text: "Avoid putting two interviews back-to-back for the same interviewer and add a prep reminder ten minutes before each slot.",
      plannerIncludesAny: ["calendar_action", "OWNER_REMINDERS", "prep"],
      plannerExcludes: ["owner_send_message"],
      // The load-protection pass must still reason over the seeded panels.
      responseIncludesAny: ["velt", "castellan"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must apply the load rule to the seeded interviewers (Velt and Castellan) — confirming their slots are not back-to-back — and set a ten-minute prep reminder before each slot. A reply that never engages the seeded panel names fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded panels the coordination was graded against really persisted.
    {
      type: "definitionCountDelta",
      title: "Interview panel — product, Arjen Velt (45 min)",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Interview panel — engineering, Moira Castellan (45 min)",
      delta: 1,
      cadenceKind: "once",
    },
    // NEGATIVE OUTCOME: the candidate email stayed staged, never sent.
    {
      type: "custom",
      name: "candidate-email-not-dispatched",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "hiring-loop-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the interview loop was built from the seeded Velt and Castellan panels, two concrete slots were proposed with prep reminders and no back-to-back load, and the candidate email stayed a staged draft with nothing dispatched externally.",
    },
  ],
});
