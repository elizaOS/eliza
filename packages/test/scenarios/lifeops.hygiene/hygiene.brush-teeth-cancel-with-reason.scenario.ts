/**
 * Hygiene: user previews a brush-teeth habit then cancels with a reason
 * ("nvm, I already have one"). Verifies the agent gracefully drops the
 * proposed definition without creating a duplicate.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
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
      responseIncludesAny: ["brush", "teeth"],
    },
    {
      kind: "message",
      name: "brush cancel with reason",
      text: "Actually never mind, I already have a brushing habit. Don't add another one.",
      responseExcludes: ['saved "brush teeth"'],
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
