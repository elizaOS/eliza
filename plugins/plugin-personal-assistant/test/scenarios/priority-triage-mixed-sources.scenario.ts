import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * OUTCOME rewrite of the routing-only priority-triage scenario (#9310): the
 * old file only asserted the planner said PRIORITIZE and the reply echoed
 * prompt keywords ("block", "priority", "decision", "noise" — all present in
 * the user's own turn text), against zero seeded state.
 *
 * This version seeds REAL mixed-priority state through the LifeOps definition
 * API — a P1 item that blocks other people ("Approve Ravenna accrual so
 * finance can close") and a P4 informational item ("Skim Meridian newsletter
 * digest") — and asserts the ranking outcome: the reply must put the seeded
 * blocker above the seeded noise (both tokens absent from every user turn),
 * and the "turn the top blocker into a follow-up" turn must produce a
 * captured scheduled action whose arguments carry the blocker.
 */
export default scenario({
  lane: "live-only",
  id: "priority-triage-mixed-sources",
  title:
    "Priority triage ranks the seeded blocker above seeded noise and schedules it",
  domain: "executive.prioritization",
  tags: ["lifeops", "executive-assistant", "prioritize", "inbox", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Priority Triage Mixed Sources",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed P1 blocker: Ravenna accrual approval",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Approve Ravenna accrual so finance can close",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+120m}}",
          visibilityLeadMinutes: 480,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed P4 noise: Meridian newsletter digest",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Skim Meridian newsletter digest",
        timezone: "UTC",
        priority: 4,
        cadence: {
          kind: "once",
          dueAt: "{{now+300m}}",
          visibilityLeadMinutes: 480,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "rank-cross-source-blockers",
      room: "main",
      text: "Rank my open items. Put anything blocking other people above informational noise.",
      plannerExcludes: ["owner_send_message"],
      // Grounding outcome: the ranking must surface the seeded blocker —
      // "ravenna" appears in no user turn, so an echo cannot pass.
      responseIncludesAll: ["ravenna"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The ranking must place the seeded blocker (the Ravenna accrual approval that blocks finance closing) above the seeded informational item (the Meridian newsletter digest), with the blocking-other-people rationale stated. Ranking the newsletter first, or omitting the seeded items, fails.",
      },
    },
    {
      kind: "message",
      name: "convert-top-blocker",
      room: "main",
      text: "Turn the top blocker into a follow-up I won't miss.",
      plannerExcludes: ["calendar_action", "gmail_action"],
      responseIncludesAny: ["ravenna", "accrual"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must confirm a concrete, hard-to-miss follow-up was created for the Ravenna accrual approval specifically (the seeded top blocker), not for a different item and not a bare acknowledgement.",
      },
    },
  ],
  finalChecks: [
    // The seeded state the ranking was graded against really persisted.
    {
      type: "definitionCountDelta",
      title: "Approve Ravenna accrual so finance can close",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Skim Meridian newsletter digest",
      delta: 1,
      cadenceKind: "once",
    },
    // OUTCOME: the top blocker became a captured scheduled action whose
    // arguments carry the blocker — not just reply wording.
    {
      type: "selectedActionArguments",
      name: "top-blocker-followup-with-args",
      actionName: [
        "SCHEDULED_TASKS",
        "OWNER_REMINDERS",
        "OWNER_TODOS",
        "LIFE",
        "PRIORITIZE",
      ],
      includesAny: ["ravenna", "accrual"],
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "priority-triage-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the triage ranked the seeded people-blocking item above the seeded informational item and converted that specific blocker into a real follow-up.",
    },
  ],
});
