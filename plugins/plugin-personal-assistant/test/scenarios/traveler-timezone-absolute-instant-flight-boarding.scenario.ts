import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "traveler.timezone.absolute-instant-flight-boarding",
  title:
    "Traveler: absolute-instant reminder survives a timezone-change signal",
  domain: "executive.travel",
  tags: ["lifeops", "traveler", "timezone", "outcome"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [{ id: "main", source: "telegram", title: "Elena Road Timezone" }],
  seed: [
    {
      type: "custom",
      apply: async (ctx) => {
        await ctx.seedMemory?.({
          content: {
            text: "Owner fact: frequent international traveler, home timezone America/New_York, current trip to Asia/Tokyo through the 12th.",
          },
        });
      },
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed existing NY-anchored calendar context",
      method: "POST",
      path: "/api/lifeops/definitions",
      // Canonical CreateLifeOpsDefinitionRequest shape: the route validates
      // `kind` and a structured `cadence` object; flat cadenceKind/dueAt
      // fields are rejected before a definition (and its id) ever exists.
      // The route answers with a LifeOpsDefinitionRecord envelope, so the id
      // lives at `definition.id`, not at the response root.
      body: {
        kind: "task",
        title: "Board flight NRT-JFK",
        timezone: "America/New_York",
        priority: 1,
        cadence: { kind: "once", dueAt: "{{now+2d}}" },
      },
      expectedStatus: 201,
      captures: { flightDefinitionId: "definition.id" },
    },
    {
      kind: "message",
      name: "ambiguous local-time ask",
      text: "remind me 9am Tuesday to call the Tokyo office before I board",
      responseIncludesAny: [
        "which timezone",
        "Tokyo time",
        "New York time",
        "confirm the zone",
      ],
      responseExcludes: ["saved", "all set", "reminder set"],
    },
    {
      kind: "message",
      name: "clarify zone",
      text: "Tokyo time, I'll still be there Tuesday morning",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Call Tokyo office",
      titleAliases: ["Call the Tokyo office", "Tokyo office call"],
      delta: 1,
      cadenceKind: "once",
      expectedTimeZone: "Asia/Tokyo",
      requireReminderPlan: true,
    },
    {
      type: "reminderIntensity",
      title: "Call Tokyo office",
      titleAliases: ["Call the Tokyo office"],
      expected: "normal",
    },
    {
      type: "judgeRubric",
      name: "asked-not-assumed-timezone",
      rubric:
        "The assistant asked the user to disambiguate which timezone '9am Tuesday' meant before committing the reminder, rather than silently assuming home or device timezone.",
      minimumScore: 0.8,
    },
  ],
});
