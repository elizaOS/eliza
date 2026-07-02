/**
 * Sleep: wake-up alarm cascade — user wants escalating alarms at 7:00, 7:05,
 * 7:10. This is a multi-trigger habit (3 slots within 10 minutes).
 *
 * De-echoed for #9310: the old turn assertions ("7"/"alarm"/"wake",
 * "saved"/"alarm"/"wake") were satisfiable by parroting the prompt. The
 * persisted definition (`definitionCountDelta`) is the load-bearing outcome;
 * the turn checks now enforce the two-phase commit instead. ("set up" is
 * deliberately absent from the confirm keywords — the prompt itself says
 * "Set up escalating wake-up alarms".)
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "sleep.wake-up-alarm-cascade",
  title: "Wake-up alarm cascade at 7:00, 7:05, 7:10",
  domain: "lifeops.sleep",
  tags: ["lifeops", "sleep", "alarm", "cascade"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Sleep Alarm Cascade",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "alarm cascade preview",
      text: "Set up escalating wake-up alarms for me at 7:00, 7:05, and 7:10 every weekday.",
      // Two-phase commit: the preview must not claim the cascade was already
      // persisted before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose the full three-slot weekday cascade (7:00, 7:05, 7:10) and ask the owner to confirm before saving. Dropping a slot, claiming it is already saved, or a bare acknowledgement with no schedule, fails.",
      },
    },
    {
      kind: "message",
      name: "alarm cascade confirm",
      text: "Yes, save it.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Wake up alarm",
      titleAliases: ["Alarm cascade", "Wake-up alarm", "Morning alarm"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
