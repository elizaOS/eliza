/**
 * Hygiene: night-owl phrasing — "I'm usually up really late". The agent
 * should still bind both brushing slots to wake-up + bedtime windows without
 * inventing a 4am alarm.
 *
 * De-echoed for #9310: the old turn assertions ("brush", "wake", "bed" /
 * "saved", "brush") were satisfiable by parroting the prompt. The persisted
 * twice-daily definition with canonical Morning/Night slots
 * (`definitionCountDelta`) is the load-bearing outcome; the turn checks now
 * enforce the derived normalization ("when I wake up" -> a morning slot — a
 * word the prompt never used) and the two-phase commit.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.brush-teeth-night-owl-schedule",
  title: "Brush teeth twice daily for a night-owl phrasing",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "colloquial"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Brush Night Owl",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush night-owl preview",
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
      name: "brush night-owl confirm",
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
