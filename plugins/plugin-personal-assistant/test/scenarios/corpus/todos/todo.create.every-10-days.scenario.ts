/** Scenario fixture for todo create every 10 days; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

// 10 days * 24 hours * 60 minutes = 14,400 minutes
const EVERY_10_DAYS_MINUTES = 14_400;

export default scenario({
  lane: "live-only",
  id: "todo.create.every-10-days",
  title: "Create an every-10-days Invisalign tray swap todo",
  domain: "todos",
  tags: ["lifeops", "todos", "ambiguous-parameter"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Invisalign Every 10 Days",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "invisalign-10d preview",
      text: "Every 10 days, remind me to swap my Invisalign tray.",
      // Two-phase commit (#9310): the old keywords were echoes of this turn's
      // own text. The preview must not claim persistence before the owner
      // confirms; definitionCountDelta (with requiredEveryMinutes) stays
      // load-bearing.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a recurring every-10-day Invisalign tray-swap todo and ask the owner to confirm before saving. Claiming it is already saved, or a bare acknowledgement with no concrete cadence, fails.",
      },
    },
    {
      kind: "message",
      name: "invisalign-10d confirm",
      text: "Yes, save that every 10 days Invisalign swap.",
      expectedActions: ["LIFE"],
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
        "Swap invisalign tray",
        "Invisalign tray swap",
        "Change Invisalign tray",
      ],
      delta: 1,
      requiredEveryMinutes: EVERY_10_DAYS_MINUTES,
    },
  ],
});
