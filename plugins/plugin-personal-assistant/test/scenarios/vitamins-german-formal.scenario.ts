/**
 * Live-model scenario: German formal (Sie) phrasing persists a "Take vitamins"
 * habit tied to a meal window.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "vitamins-german-formal",
  title: "Vitamins tied to a meal window (German, formal Sie)",
  domain: "habits",
  tags: ["lifeops", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "signal",
      title: "LifeOps Vitamine zum Essen",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "vitamins meal preview",
      text: "Könnten Sie mich bitte jeden Tag daran erinnern, meine Vitamine zum Mittagessen einzunehmen?",
      responseIncludesAny: [
        "vitamins",
        "lunch",
        "afternoon",
        "Vitamine",
        "Mittag",
        "Nachmittag",
      ],
    },
    {
      kind: "message",
      name: "vitamins meal confirm",
      text: "Ja, speichern Sie diese Vitamin-Routine bitte ab.",
      responseIncludesAny: ["saved", "vitamin", "gespeichert", "Vitamin"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Take vitamins",
      titleAliases: [
        "Vitamine einnehmen",
        "Vitamine zum Mittagessen",
        "Vitamin-Routine",
      ],
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["afternoon"],
      requireReminderPlan: true,
    },
  ],
});
