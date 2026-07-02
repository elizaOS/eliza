/**
 * Hygiene: posture check during deep-work blocks — interval reminder that
 * should only fire when the user is in a focus session. The scenario only
 * verifies the definition is created; runtime gating is a separate concern.
 *
 * De-echoed for #9310: the old turn assertions ("posture", "30", "minutes" /
 * "saved", "posture") were satisfiable by parroting the prompt. The persisted
 * 30-minute interval definition (`definitionCountDelta`) is the load-bearing
 * outcome; the turn checks now enforce the derived scoping ("deep work" ->
 * focus sessions — "focus" appears in no user turn) and the two-phase commit.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.posture-check-during-deep-work",
  title: "Posture check every 30 minutes during deep work",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "interval", "focus"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Posture Deep Work",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "posture preview",
      text: "Remind me to check my posture every 30 minutes while I'm in deep work.",
      // Derived scoping: "deep work" must resolve to focus-session gating —
      // "focus" appears in no user turn, so echo cannot pass.
      responseIncludesAny: ["focus", "half hour", "half-hour"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a 30-minute interval posture reminder scoped to the owner's focus/deep-work sessions and ask the owner to confirm before saving. Claiming it is already saved, or proposing an all-day unconditional interval, fails.",
      },
    },
    {
      kind: "message",
      name: "posture confirm",
      text: "Yes, save it.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Posture check",
      titleAliases: ["Check posture", "Posture"],
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 30,
      requireReminderPlan: true,
    },
  ],
});
