/**
 * Hygiene: brush teeth at "wake-up and bedtime" phrasing — colloquial
 * input that should still resolve to the canonical morning+night slots.
 *
 * De-echoed for #9310: the old turn assertions ("brush", "wake", "bed" /
 * "brush") were satisfiable by parroting the prompt. The persisted
 * twice-daily definition with canonical Morning/Night slots
 * (`definitionCountDelta`) is the load-bearing outcome; the turn checks now
 * enforce the derived normalization (the preview must resolve the colloquial
 * phrasing to a morning slot — a word the prompt never used) and the
 * two-phase commit.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.brush-teeth-bedtime-wakeup",
  title: "Brush teeth from wake-up and bedtime colloquial phrasing",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "colloquial"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Hygiene Brush Wake Bed",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush wake-bed preview",
      text: "make sure i actually brush my teeth when i wake up and before bed lol",
      // Derived normalization: "when i wake up" must resolve to a morning
      // slot — "morning" appears in no user turn, so echo cannot pass.
      responseIncludesAny: ["morning"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must resolve the colloquial phrasing into a concrete twice-daily schedule (a morning slot and a night slot) and ask the owner to confirm before saving. Claiming it is already saved, or proposing a single daily reminder, fails.",
      },
    },
    {
      kind: "message",
      name: "brush wake-bed confirm",
      text: "Yes, save that.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
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
