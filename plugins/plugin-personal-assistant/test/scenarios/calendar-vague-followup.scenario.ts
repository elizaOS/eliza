import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Live-model vague calendar-followup flow. Seeds two real flight commitments
 * through the
 * headless-persistent LifeOps definition API (flight numbers "UA482" out and
 * "UA2210" back — tokens that never appear in any user turn) and asserts the
 * answers are grounded in that state rather than hallucinated (#9310): the
 * flights question must surface the
 * seeded outbound flight, and the return question must surface the seeded
 * return flight. The seeded rows are re-verified via `definitionCountDelta`.
 */
export default scenario({
  lane: "live-only",
  id: "calendar-vague-followup",
  title: "Calendar vague follow-up answers are grounded in seeded flights",
  domain: "calendar",
  tags: ["lifeops", "calendar", "executive-assistant", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Calendar Vague Follow-up",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed outbound flight UA482",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Flight UA482 to Denver",
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
      name: "seed return flight UA2210",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Flight UA2210 Denver return",
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
      name: "calendar flights this week",
      room: "main",
      text: "do i have any flights this week?",
      plannerExcludes: [
        "create_task",
        "spawn_agent",
        "send_to_agent",
        "list_agents",
      ],
      // Grounding outcome: the answer must surface the seeded outbound
      // flight number — it appears in no user turn, so echo cannot pass.
      responseIncludesAny: ["ua482", "ua 482"],
      responseExcludes: ["no active task agents", "spawned", "scratch/"],
    },
    {
      kind: "message",
      name: "calendar return flight",
      room: "main",
      text: "when do i fly back from denver",
      plannerExcludes: [
        "create_task",
        "spawn_agent",
        "send_to_agent",
        "list_agents",
      ],
      // Grounding outcome: the return answer must surface the seeded return
      // flight, not re-answer with the outbound leg.
      responseIncludesAny: ["ua2210", "ua 2210"],
      responseExcludes: ["no active task agents", "spawned", "scratch/"],
    },
    {
      kind: "message",
      name: "calendar vague follow-up",
      room: "main",
      text: "yeah, probably next week?",
      plannerExcludes: [
        "create_task",
        "spawn_agent",
        "send_to_agent",
        "list_agents",
      ],
      responseExcludes: ["no active task agents", "spawned", "scratch/"],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The vague follow-up must stay in the flight-rescheduling context (the seeded Denver trip): the assistant either proposes moving the return into next week or asks a targeted clarifying question about the return flight. Losing the thread (answering about something other than the trip) fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded flight state the answers were graded against persisted.
    {
      type: "definitionCountDelta",
      title: "Flight UA482 to Denver",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Flight UA2210 Denver return",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 3,
    },
    {
      type: "judgeRubric",
      name: "calendar-vague-followup-end-to-end",
      minimumScore: 0.6,
      rubric:
        "End-to-end: both flight answers were grounded in the seeded Denver itinerary (UA482 out, UA2210 back) and the vague 'probably next week?' follow-up was interpreted in the context of the return flight rather than dropped.",
    },
  ],
});
