/**
 * Hygiene: user previews a brush-teeth habit then cancels with a reason
 * ("nvm, I already have one"). Verifies the agent gracefully drops the
 * proposed definition without creating a duplicate.
 *
 * De-echoed for #9310: the old preview assertion ("brush", "teeth") was
 * satisfiable by parroting the prompt. `definitionCountDelta: 0` is the
 * load-bearing outcome; the turn checks now enforce the two-phase commit —
 * the preview must resolve to two distinct daily slots ("twice" appears in
 * no user turn) without claiming persistence, and the cancel turn must drop
 * the proposal without claiming anything was created.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.brush-teeth-cancel-with-reason",
  title: "Brush teeth preview is cancelled with a reason — no duplicate",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "cancel"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Brush Cancel With Reason",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush preview",
      text: "Help me brush my teeth in the morning and at night.",
      // Derived structure: the preview must resolve to two distinct daily
      // slots — "twice" appears in no user turn, so echo cannot pass.
      responseIncludesAny: ["twice", "two", "both"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a twice-daily brushing habit (a morning slot and a night slot) and ask the owner to confirm before saving. Claiming it is already saved fails.",
      },
    },
    {
      kind: "message",
      name: "brush cancel with reason",
      text: "Actually never mind, I already have a brushing habit. Don't add another one.",
      responseExcludes: ['saved "brush teeth"'],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must acknowledge dropping the proposed brushing habit because the owner already has one, and must not claim any habit was created, saved, or scheduled.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      delta: 0,
    },
  ],
});
