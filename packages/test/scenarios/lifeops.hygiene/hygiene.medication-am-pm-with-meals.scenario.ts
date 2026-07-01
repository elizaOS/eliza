/**
 * Hygiene: AM/PM medication with meals — twice-daily habit anchored to
 * breakfast and dinner windows.
 *
 * De-echoed for #9310: the old turn assertions ("medication", "breakfast",
 * "dinner" / "medication") were satisfiable by parroting the prompt. The
 * persisted twice-daily definition (`definitionCountDelta`) is the
 * load-bearing outcome; the turn checks now enforce the derived structure
 * (the preview must resolve to two distinct daily doses) and the two-phase
 * commit — no completion claim before the owner confirms, and a save
 * confirmation (in words the prompt never used) after.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.medication-am-pm-with-meals",
  title: "Medication twice daily with breakfast and dinner",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "medication", "twice-daily"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Medication With Meals",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "med meal preview",
      text: "Remind me to take my medication with breakfast and dinner every day.",
      // Derived structure: the preview must resolve to two distinct doses —
      // "twice" appears in no user turn, so echo cannot pass.
      responseIncludesAny: ["twice", "two doses", "2 doses", "both doses"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a twice-daily medication reminder anchored to the breakfast and dinner meals (two distinct doses, not one) and ask the owner to confirm before saving. Claiming it is already saved fails.",
      },
    },
    {
      kind: "message",
      name: "med meal confirm",
      text: "Yes, save it.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Take medication",
      titleAliases: ["Medication with meals", "Take meds with meals"],
      delta: 1,
      cadenceKind: "times_per_day",
      requireReminderPlan: true,
    },
  ],
});
