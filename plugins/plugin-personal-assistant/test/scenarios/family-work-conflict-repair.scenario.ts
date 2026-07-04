import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

/**
 * OUTCOME rewrite of the routing-only conflict-repair scenario (#9310): the
 * old file only asserted planner keywords plus reply echoes ("pickup",
 * "conflict", "draft", "meeting" — all present in the user's own turn text),
 * so a prompt-parroting reply passed with no calendar state to reconcile.
 *
 * This version seeds the two REAL colliding commitments through the LifeOps
 * definition API (the Greenbriar Academy pickup and the Ostrander renewal
 * call) and asserts the repair is GROUNDED in them: both tokens never appear
 * in any user turn, so an echo cannot pass; the work-facing note stays
 * grounded in the Ostrander meeting while the family-overshare judge enforces
 * that school details stay out of the customer draft. Seeds are re-verified
 * via definitionCountDelta and the draft stays staged via a no-external-send
 * predicate.
 */
export default scenario({
  lane: "live-only",
  id: "family-work-conflict-repair",
  title:
    "Family/work conflict repair grounds in seeded commitments without over-sharing",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "calendar", "messaging", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Family Work Conflict Repair",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed family commitment: school pickup",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "School pickup — Greenbriar Academy 15:00",
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
      name: "seed work commitment: customer call",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Customer call — Ostrander renewal sync 15:00",
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
      name: "detect-family-work-conflict",
      room: "main",
      text: "Check if school pickup conflicts with the customer call tomorrow. If it does, propose the least disruptive repair and draft only the work-facing note.",
      plannerIncludesAny: ["calendar_action", "family", "draft"],
      plannerExcludes: ["OWNER_HEALTH", "OWNER_FINANCES"],
      // Grounding outcome: the conflict finding must reference BOTH seeded
      // commitments — neither token appears in any user turn.
      responseIncludesAll: ["greenbriar", "ostrander"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must detect the real collision between the seeded Greenbriar Academy pickup and the Ostrander renewal call at the same time, propose a concrete least-disruptive repair, and stage only the work-facing note. A generic 'let me check your calendar' or a repair that names neither seeded commitment fails.",
      },
    },
    {
      kind: "message",
      name: "avoid-family-overshare",
      room: "main",
      text: "Do not mention school or family details in the customer note; just say I need to move the meeting.",
      plannerIncludesAny: ["owner_send_message", "privacy", "customer"],
      plannerExcludes: ["OWNER_DOCUMENTS"],
      // The revised customer note must still be grounded in the seeded work
      // meeting ("ostrander" never appears in any user turn).
      responseIncludesAny: ["ostrander"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The revised customer-facing note must reference the Ostrander meeting being moved and give a neutral reason, with zero school, pickup, or family wording inside the note text. Leaking the school name or any family detail into the customer note, or claiming the note was already sent, fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded commitments the repair was graded against really persisted.
    {
      type: "definitionCountDelta",
      title: "School pickup — Greenbriar Academy 15:00",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Customer call — Ostrander renewal sync 15:00",
      delta: 1,
      cadenceKind: "once",
    },
    // NEGATIVE OUTCOME: the customer note stayed staged, never sent.
    {
      type: "custom",
      name: "customer-note-not-dispatched",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "family-work-repair-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the collision between the seeded Greenbriar pickup and Ostrander call was detected from real state, the least-disruptive repair was proposed, and the customer note stayed a staged draft that never mentioned school or family details.",
    },
  ],
});
