/**
 * Hygiene: wash hair twice a week — weekly cadence with 2 weekday slots.
 *
 * De-echoed for #9310: the old turn assertions ("hair", "wash", "twice",
 * "week" / "saved", "hair") were satisfiable by parroting the prompt. The
 * persisted weekly definition (`definitionCountDelta`) is the load-bearing
 * outcome; the turn checks now enforce the derived schedule (the preview
 * must name concrete weekdays — no weekday appears in any user turn) and the
 * two-phase commit.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.hair-wash-twice-weekly",
  title: "Wash hair twice a week",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "weekly"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Hair Wash",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "hair wash preview",
      text: "Help me remember to wash my hair twice a week.",
      // Derived schedule: the preview must pin the two washes to concrete
      // weekdays — no weekday name appears in any user turn.
      responseIncludesAny: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a twice-weekly hair-wash schedule on two specific days of the week and ask the owner to confirm before saving. Claiming it is already saved, or leaving the days unspecified, fails.",
      },
    },
    {
      kind: "message",
      name: "hair wash confirm",
      text: "Yes, save that.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Wash hair",
      titleAliases: ["Hair wash", "Wash my hair"],
      delta: 1,
      cadenceKind: "weekly",
      requireReminderPlan: true,
    },
  ],
});
