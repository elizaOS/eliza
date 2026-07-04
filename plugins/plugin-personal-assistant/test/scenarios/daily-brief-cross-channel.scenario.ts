// Defines the daily brief cross channel LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * OUTCOME rewrite of the routing-only daily-brief scenario (#9310): the old
 * file only asserted the planner said BRIEF and the reply echoed prompt
 * keywords ("calendar", "urgent", "draft", "bill", "need" — all present in
 * the user's own turn text), so a parroted reply passed against an empty day.
 *
 * This version seeds REAL owner state through the headless-persistent LifeOps
 * definition API (two commitments due today: the Meridian invoice payment and
 * the Halcyon partnership prep) and asserts the brief is GROUNDED in it: the
 * reply must surface the seeded "Meridian" and "Halcyon" items — tokens that
 * never appear in any user turn, so echoing the prompt cannot pass. The
 * seeded rows are re-verified via `definitionCountDelta` at the end.
 */
export default scenario({
  lane: "live-only",
  id: "daily-brief-cross-channel",
  title: "Daily brief is grounded in seeded calendar, task, and money state",
  domain: "executive.briefing",
  tags: ["lifeops", "executive-assistant", "briefing", "inbox", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Daily Brief Cross Channel",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed due bill: Meridian invoice",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Pay Meridian invoice",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+120m}}",
          visibilityLeadMinutes: 480,
          visibilityLagMinutes: 720,
        },
        reminderPlan: {
          steps: [
            {
              channel: "in_app",
              offsetMinutes: 0,
              label: "Pay the Meridian invoice",
            },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed due prep task: Halcyon partnership sync",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Prep Halcyon partnership sync",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+240m}}",
          visibilityLeadMinutes: 480,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "daily-brief",
      room: "main",
      text: "Give me the brief: what's due today, unread urgent messages, waiting drafts, bills due, and what you need from me.",
      plannerExcludes: ["spawn_agent", "send_to_agent", "list_agents"],
      // Grounding outcome: the brief must surface BOTH seeded commitments.
      // Neither token appears in any user turn, so an echo cannot pass.
      responseIncludesAll: ["meridian", "halcyon"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The brief must surface the two seeded commitments — the Meridian invoice payment (money, high priority) and the Halcyon partnership prep — with their due-today timing, structured as a scannable brief. A generic brief that omits the seeded items fails.",
      },
    },
    {
      kind: "message",
      name: "compress-brief",
      room: "main",
      text: "Now compress that into a five-line executive summary with the one decision I should make first.",
      plannerExcludes: ["calendar_action", "gmail_action"],
      // The compressed summary must still be grounded in the seeded state.
      responseIncludesAny: ["meridian", "halcyon"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The compressed summary must stay grounded in the seeded items (Meridian invoice / Halcyon prep), be at most about five lines, and name exactly one first decision. Losing the seeded items in compression fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded state the brief was graded against really persisted.
    {
      type: "definitionCountDelta",
      title: "Pay Meridian invoice",
      delta: 1,
      cadenceKind: "once",
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Prep Halcyon partnership sync",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "daily-brief-grounding-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the brief and its compressed summary were grounded in the seeded owner state (Meridian invoice due, Halcyon prep) rather than generic filler, and the compression surfaced a single first decision.",
    },
  ],
});
