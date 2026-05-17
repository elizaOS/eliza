/**
 * Hygiene: moisturizer after every shower — daily habit linked conceptually
 * to the shower habit. The agent should not collapse the two; this is its
 * own definition tied to morning + night (or after the user's shower window).
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.moisturizer-after-shower",
  title: "Moisturizer after every shower",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Moisturizer",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "moisturizer preview",
      text: "Remind me to put on moisturizer after every shower.",
      responseIncludesAny: ["moisturizer", "shower"],
    },
    {
      kind: "message",
      name: "moisturizer confirm",
      text: "Yes, save it.",
      responseIncludesAny: ["saved", "moisturizer"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Moisturizer",
      titleAliases: ["Apply moisturizer", "Put on moisturizer"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
