/** Scenario fixture for reminder invisalign tray every 10 days; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "reminder.invisalign-tray.every-10-days",
  title: "Invisalign tray swap every 10 days",
  domain: "reminders",
  tags: ["lifeops", "reminders", "smoke", "critical", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Reminders Invisalign Tray Every 10 Days",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "invisalign tray preview",
      text: "Remind me to swap Invisalign trays every 10 days.",
      // Two-phase commit (#9310): the old keywords ("invisalign"/"tray"/"10")
      // were echoes of this turn's own text. The preview must not claim
      // persistence before the owner confirms; definitionCountDelta stays
      // load-bearing.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a recurring every-10-day tray-swap reminder and ask the owner to confirm before saving. Claiming it is already saved, or a bare acknowledgement with no concrete cadence, fails.",
      },
    },
    {
      kind: "message",
      name: "invisalign tray confirm",
      text: "Yes, save that recurring reminder.",
      // Save-confirmation semantics in words the prompt never used; the real
      // outcome is the persisted definition asserted in finalChecks.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Swap Invisalign tray",
      titleAliases: [
        "Switch Invisalign tray",
        "Change Invisalign tray",
        "New Invisalign tray",
      ],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
