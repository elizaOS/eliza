/**
 * Live-model night-owl brushing-habit flow. The load-bearing outcome is the
 * persisted twice-daily definition with canonical Morning/Night slots
 * (`definitionCountDelta`); the turn checks enforce the derived normalization
 * ("when I wake up" -> a morning slot, a word the prompt never uses) and the
 * two-phase commit (#9310).
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "brush-teeth-night-owl",
  title: "Brush teeth for a night-owl phrasing",
  domain: "habits",
  tags: ["lifeops", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Brush Teeth Night Owl",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth night-owl preview",
      text: "I'm usually up really late, but please help me brush my teeth when I wake up and before I finally go to bed.",
      // Derived normalization: "when I wake up" must resolve to a morning
      // slot — "morning" appears in no user turn, so echo cannot pass.
      responseIncludesAny: ["morning"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must resolve the night-owl phrasing into a concrete twice-daily schedule (a morning wake-up slot and a night slot) and ask the owner to confirm before saving. Claiming it is already saved, or proposing a middle-of-the-night alarm, fails.",
      },
    },
    {
      kind: "message",
      name: "brush-teeth night-owl confirm",
      text: "Yes, save that brushing routine.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: ["brush teeth"],
      delta: 1,
      cadenceKind: "times_per_day",
      requiredSlots: [
        { label: "Morning", minuteOfDay: 480 },
        { label: "Night", minuteOfDay: 1260 },
      ],
      requireReminderPlan: true,
    },
  ],
});
