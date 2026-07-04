import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * OUTCOME rewrite of the routing-only evacuation-runbook scenario (#9310):
 * the old file only asserted planner keywords plus reply echoes ("pets",
 * "insurance", "roles", "6pm" — all present in the user's own turn text), so
 * a prompt-parroting reply passed against zero seeded state.
 *
 * This version seeds REAL household state — the pet ("Biscuit") and the
 * sitter ("Rosalba") appear in NO user turn — and asserts the runbook is
 * grounded in them. The roles turn must convert the runbook into a captured
 * scheduled action whose arguments carry the seeded household specifics
 * (selectedActionArguments), not just reply wording.
 */
export default scenario({
  lane: "live-only",
  id: "emergency-home-evacuation-runbook",
  title:
    "Evacuation runbook is grounded in seeded household state and schedules the reminder ladder",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "documents", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Emergency Home Evacuation Runbook",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed pet go-bag task",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title:
          "Go-bag checklist and pet records for Biscuit — carrier lives in the hall closet",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+1d}}",
          visibilityLeadMinutes: 2880,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed sitter coverage task",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Sitter Rosalba covers school pickup if we evacuate",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+1d}}",
          visibilityLeadMinutes: 2880,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "assemble-evacuation-runbook",
      room: "main",
      text: "Wildfire risk is rising. Pull together what we're already tracking: pet records, the insurance policy, the go-bag checklist, the school pickup plan, and who is out of town this week.",
      plannerExcludes: ["OWNER_HEALTH"],
      // Grounding outcome: the runbook must surface the seeded pet — the name
      // appears in no user turn, so an echo cannot pass.
      responseIncludesAll: ["biscuit"],
      responseIncludesAny: ["rosalba"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The runbook must be grounded in the tracked household state: the named pet's go-bag/records item and the named sitter's pickup coverage, alongside insurance and out-of-town gaps. A generic evacuation template that never touches the tracked items fails.",
      },
    },
    {
      kind: "message",
      name: "assign-household-roles",
      room: "main",
      text: "Turn that into roles for me, my partner, and the sitter, with a reminder ladder if nobody confirms by 6pm.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseIncludesAny: ["rosalba", "biscuit"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must assign concrete roles — owner, partner, and the named sitter — covering the pet and pickup items, and set a real reminder ladder that escalates when nobody confirms by 6pm. Vague role labels with no ladder, or roles that ignore the tracked items, fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title:
        "Go-bag checklist and pet records for Biscuit — carrier lives in the hall closet",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Sitter Rosalba covers school pickup if we evacuate",
      delta: 1,
      cadenceKind: "once",
    },
    // OUTCOME: the reminder ladder became a captured scheduled action whose
    // arguments carry the seeded household specifics — not just wording.
    {
      type: "selectedActionArguments",
      name: "evacuation-ladder-with-args",
      actionName: [
        "SCHEDULED_TASKS",
        "OWNER_REMINDERS",
        "OWNER_TODOS",
        "LIFE",
        "PRIORITIZE",
      ],
      includesAny: ["rosalba", "biscuit", "evacuat", "go-bag"],
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "evacuation-runbook-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the runbook surfaced the seeded pet and sitter work, roles were assigned per person, and the 6pm reminder ladder was actually created rather than promised.",
    },
  ],
});
