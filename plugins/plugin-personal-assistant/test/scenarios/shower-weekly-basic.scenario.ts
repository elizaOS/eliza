import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Live-model scenario: a weekly-shower request persists a Mon/Wed/Fri
 * definition (`definitionCountDelta` with `requiredWeekdays` +
 * `requiredWindows`). The turn checks enforce the derived spread (three
 * concrete weekdays — no weekday name appears in any user turn) and the
 * two-phase commit: no persistence claim in the preview, and save-confirmation
 * words the prompt never used on confirm.
 */
export default scenario({
  lane: "live-only",
  id: "shower-weekly-basic",
  title: "Shower weekly cadence",
  domain: "habits",
  tags: ["lifeops", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Shower Weekly",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "shower weekly preview",
      text: "Please remind me to shower three times a week.",
      // Derived spread: the preview must pin the three showers to the
      // canonical Mon/Wed/Fri weekdays the finalCheck requires — no weekday
      // name appears in any user turn, so echo cannot pass.
      responseIncludesAll: ["monday", "wednesday", "friday"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a three-times-weekly shower schedule on three specific spread-out weekdays (Monday/Wednesday/Friday) and ask the owner to confirm before saving. Claiming it is already saved, or leaving the days unspecified, fails.",
      },
    },
    {
      kind: "message",
      name: "shower weekly confirm",
      text: "Yes, save that routine.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Shower",
      delta: 1,
      cadenceKind: "weekly",
      requiredWeekdays: [1, 3, 5],
      requiredWindows: ["morning", "night"],
      requireReminderPlan: true,
    },
  ],
});
