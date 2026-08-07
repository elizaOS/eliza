/** Scenario fixture for todo create weekly weekday; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "todo.create.weekly-weekday",
  title: "Create a weekday morning recurring stretch todo",
  domain: "todos",
  tags: ["lifeops", "todos", "time-of-day-edge"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Weekly Weekday Stretch",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "weekday-stretch preview",
      text: "Every weekday morning, remind me to stretch.",
      // Two-phase commit (#9310): the old keywords were echoes of this turn's
      // own text. The preview must not claim persistence before the owner
      // confirms; definitionCountDelta (weekdays + morning window) stays
      // load-bearing.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a Monday-through-Friday morning stretch routine and ask the owner to confirm before saving. Claiming it is already saved, or a bare acknowledgement with no concrete schedule, fails.",
      },
    },
    {
      kind: "message",
      name: "weekday-stretch confirm",
      text: "Yes, save that weekday morning stretch routine.",
      expectedActions: ["LIFE"],
      // Save-confirmation semantics in words the prompt never used; the real
      // outcome is the persisted definition asserted in finalChecks.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Stretch",
      titleAliases: ["Morning stretch", "Weekday stretch"],
      delta: 1,
      requiredWeekdays: [1, 2, 3, 4, 5],
      requiredWindows: ["morning"],
    },
  ],
});
