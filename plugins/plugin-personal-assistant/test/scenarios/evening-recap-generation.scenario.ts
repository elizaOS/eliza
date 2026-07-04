/**
 * Live-model evening-recap flow (#8795 item 6, de-larped for #9310): seeds real
 * owner state through the LifeOps definition API — a commitment that slipped today
 * ("File Brightline expense report") and one still ahead ("Review Ondine draft
 * agenda") — and asserts the recap surfaces the seeded "Brightline" and "Ondine"
 * items, absent from every user turn. The carry-forward turn reschedules the
 * slipped item as a real captured scheduled action (selectedActionArguments).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "evening-recap-generation",
  title:
    "Evening recap grounds in seeded slipped/upcoming state and carries forward",
  domain: "executive.briefing",
  tags: [
    "lifeops",
    "briefing",
    "recap",
    "evening",
    "executive-assistant",
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
      title: "LifeOps Evening Recap",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed slipped task: Brightline expense report",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "File Brightline expense report",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now-120m}}",
          visibilityLeadMinutes: 480,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed upcoming task: Ondine draft agenda",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Review Ondine draft agenda",
        timezone: "UTC",
        priority: 3,
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
      name: "evening-recap",
      room: "main",
      text: "Give me my evening recap: what I finished, what slipped, and what needs me tomorrow.",
      plannerExcludes: ["spawn_agent", "send_to_agent", "list_agents"],
      // Grounding outcome: the recap must surface the seeded items — tokens
      // that never appear in any user turn, so an echo cannot pass.
      responseIncludesAll: ["brightline", "ondine"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The recap must be grounded in the seeded state: the Brightline expense report is called out as slipped/overdue and the Ondine agenda review as still ahead. A generic recap that omits the seeded items, or claims the slipped item was finished, fails.",
      },
    },
    {
      kind: "message",
      name: "carry-forward",
      room: "main",
      text: "Carry anything I didn't finish into tomorrow's plan.",
      plannerExcludes: ["gmail_action"],
      responseIncludesAny: ["brightline"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must carry the slipped Brightline expense report into tomorrow's plan as a concrete rescheduled item (not a vague 'noted'), and must not carry forward items that were not slipped.",
      },
    },
  ],
  finalChecks: [
    // The seeded state the recap was graded against really persisted.
    {
      type: "definitionCountDelta",
      title: "File Brightline expense report",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Review Ondine draft agenda",
      delta: 1,
      cadenceKind: "once",
    },
    // OUTCOME: the carry-forward became a captured action whose arguments
    // carry the slipped item — not just reply wording.
    {
      type: "selectedActionArguments",
      name: "carry-forward-captured-with-args",
      actionName: [
        "SCHEDULED_TASKS",
        "OWNER_REMINDERS",
        "OWNER_TODOS",
        "LIFE",
        "PRIORITIZE",
        "BRIEF",
      ],
      includesAny: ["brightline", "expense"],
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "evening-recap-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the evening recap was grounded in seeded owner state (Brightline slipped, Ondine ahead) and the slipped item was actually carried into tomorrow's plan.",
    },
  ],
});
