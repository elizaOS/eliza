/**
 * Hygiene: AM and PM skincare routine — two slots per day, distinct from
 * brushing. The agent should keep the routine as a single twice-daily habit
 * rather than splitting into morning and evening habits.
 *
 * De-echoed for #9310: the old turn assertions ("skincare", "morning",
 * "night" / "saved", "skincare") were satisfiable by parroting the prompt.
 * The persisted twice-daily definition (`definitionCountDelta`) is the
 * load-bearing outcome; the turn checks now enforce the derived structure
 * (one habit with two daily slots — "twice" appears in no user turn) and the
 * two-phase commit.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.skincare-am-pm-routine",
  title: "Skincare routine twice daily, AM and PM",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "twice-daily"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Skincare AM PM",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "skincare preview",
      text: "Remind me to do my skincare routine every morning and every night.",
      // Derived structure: the preview must resolve to one twice-daily habit
      // — "twice" / "both" appear in no user turn, so echo cannot pass.
      responseIncludesAny: ["twice", "both", "am and pm", "2 slots"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a single twice-daily skincare habit with an AM slot and a PM slot (not two separate habits) and ask the owner to confirm before saving. Claiming it is already saved fails.",
      },
    },
    {
      kind: "message",
      name: "skincare confirm",
      text: "Yes, save that routine.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Skincare routine",
      titleAliases: ["Skincare", "AM/PM skincare", "Skin care routine"],
      delta: 1,
      cadenceKind: "times_per_day",
      requireReminderPlan: true,
    },
  ],
});
