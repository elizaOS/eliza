/**
 * Live-model scenario: Italian phrasing persists a "Take vitamins" habit tied
 * to a meal window.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "vitamins-italian",
  title: "Vitamins from Italian phrasing (neutral register)",
  domain: "habits",
  tags: ["lifeops", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "whatsapp",
      title: "LifeOps Vitamine a Pranzo",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "vitamins meal preview",
      text: "Ricordami di prendere le vitamine a pranzo tutti i giorni.",
      responseIncludesAny: [
        "vitamins",
        "lunch",
        "afternoon",
        "vitamine",
        "pranzo",
      ],
    },
    {
      kind: "message",
      name: "vitamins meal confirm",
      text: "Sì, salva questa routine delle vitamine.",
      responseIncludesAny: ["saved", "vitamin", "salv", "vitamine"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Take vitamins",
      titleAliases: [
        "Prendere le vitamine",
        "Vitamine a pranzo",
        "Routine delle vitamine",
      ],
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["afternoon"],
      requireReminderPlan: true,
    },
  ],
});
