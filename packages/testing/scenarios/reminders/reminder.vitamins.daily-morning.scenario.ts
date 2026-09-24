/** Scenario fixture for reminder vitamins daily morning; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "reminder.vitamins.daily-morning",
  title: "Daily vitamins reminder in the morning window",
  domain: "reminders",
  tags: ["lifeops", "reminders", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "Reminders Vitamins Morning",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "vitamins morning preview",
      text: "Please remind me to take my vitamins every morning.",
      // Two-phase commit (#9310): the old keywords ("vitamin"/"morning") were
      // echoes of this turn's own text. The preview must not claim
      // persistence before the owner confirms; definitionCountDelta stays
      // load-bearing.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a daily morning-window vitamins reminder and ask the owner to confirm before saving. Claiming it is already saved, or a bare acknowledgement with no concrete cadence, fails.",
      },
    },
    {
      kind: "message",
      name: "vitamins morning confirm",
      text: "Yes, save that reminder.",
      // Save-confirmation semantics in words the prompt never used; the real
      // outcome is the persisted definition asserted in finalChecks.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Take vitamins",
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["morning"],
      requireReminderPlan: true,
    },
  ],
});
