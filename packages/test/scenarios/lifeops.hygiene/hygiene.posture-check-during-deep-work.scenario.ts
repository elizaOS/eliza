/**
 * Hygiene: posture check during deep-work blocks — interval reminder that
 * should only fire when the user is in a focus session. The scenario only
 * verifies the definition is created; runtime gating is a separate concern.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
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
      responseIncludesAny: ["posture", "30", "minutes"],
    },
    {
      kind: "message",
      name: "posture confirm",
      text: "Yes, save it.",
      responseIncludesAny: ["saved", "posture"],
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
