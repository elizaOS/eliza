// Defines the delegation map status compression LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * OUTCOME rewrite of the routing-only delegation-map scenario (#9310): the
 * old file only asserted planner keywords plus reply echoes ("owner", "due",
 * "status", "blocked" — all present in the user's own turn text), so a
 * prompt-parroting reply passed against zero seeded state.
 *
 * This version seeds REAL delegations — a blocked item ("Kirkbride vendor
 * redline" delegated to Ansel) and an on-track item (finance recap owed by
 * Odette) that appear in NO user turn — and asserts the map and the
 * compression are grounded in them. The follow-up conversion must land as a
 * captured scheduled action whose arguments carry the blocked item
 * (selectedActionArguments), not just reply wording.
 */
export default scenario({
  lane: "live-only",
  id: "delegation-map-status-compression",
  title:
    "Delegation map surfaces seeded items and converts only the blocked one into a follow-up",
  domain: "executive.delegation",
  tags: ["lifeops", "executive-assistant", "prioritize", "followup", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Delegation Map Status Compression",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed blocked delegation",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title:
          "Delegated to Ansel: return the Kirkbride vendor redline — blocked on their counsel",
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
      name: "seed on-track delegation",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title:
          "Delegated to Odette: finance recap owed back to me Friday — on track",
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
      name: "build-delegation-map",
      room: "main",
      text: "Map what I delegated this week across email, chat, and calendar notes. Group what we're already tracking by owner, due date, and whether I owe a reply.",
      plannerExcludes: ["OWNER_HEALTH"],
      // Grounding outcome: the map must surface the seeded blocked item — it
      // appears in no user turn, so an echo cannot pass.
      responseIncludesAll: ["kirkbride"],
      responseIncludesAny: ["odette", "ansel"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The map must be grounded in the tracked delegations: the vendor redline delegated to its named owner (blocked on counsel) and the finance recap owed by its named owner, grouped by owner and due date. A generic delegation template that never touches the tracked items fails.",
      },
    },
    {
      kind: "message",
      name: "compress-status-review",
      room: "main",
      text: "Compress it into a five-line status review and create follow-ups only for items blocked on someone else.",
      plannerExcludes: ["owner_send_message"],
      responseIncludesAny: ["kirkbride", "ansel"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The compressed review must stay within roughly five lines and create a follow-up ONLY for the blocked vendor-redline item — not for the on-track finance recap. Creating follow-ups for everything, or for nothing, fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title:
        "Delegated to Ansel: return the Kirkbride vendor redline — blocked on their counsel",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title:
        "Delegated to Odette: finance recap owed back to me Friday — on track",
      delta: 1,
      cadenceKind: "once",
    },
    // OUTCOME: the blocked item became a captured scheduled action whose
    // arguments carry it — not just reply wording.
    {
      type: "selectedActionArguments",
      name: "blocked-item-followup-with-args",
      actionName: [
        "SCHEDULED_TASKS",
        "OWNER_REMINDERS",
        "OWNER_TODOS",
        "LIFE",
        "PRIORITIZE",
      ],
      includesAny: ["kirkbride", "ansel"],
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "delegation-map-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the map surfaced both seeded delegations with owners and due dates, the compression kept it tight, and only the blocked item was converted into a real follow-up.",
    },
  ],
});
