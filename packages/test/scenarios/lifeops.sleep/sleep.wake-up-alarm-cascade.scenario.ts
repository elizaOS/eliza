/**
 * Sleep: wake-up alarm cascade — user wants escalating alarms at 7:00, 7:05,
 * 7:10. This is a multi-trigger habit (3 slots within 10 minutes).
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
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
      responseIncludesAny: ["7", "alarm", "wake", "weekday"],
    },
    {
      kind: "message",
      name: "alarm cascade confirm",
      text: "Yes, save it.",
      responseIncludesAny: ["saved", "alarm", "wake"],
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
