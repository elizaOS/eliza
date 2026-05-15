// Test fixture: inline `examples: [[user, agent]]` array literal.
// Mirrors the canonical app-lifeops action shape.

import type { Action, ActionExample } from "@elizaos/core";

export const fixtureInlineAction: Action = {
  name: "FIXTURE_INLINE",
  description: "Inline-examples test fixture",
  validate: async () => true,
  handler: async () => undefined,
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "play the strokes first single" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Let me look that up!", actions: ["FIXTURE_INLINE"] },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "play radiohead" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Finding radiohead!", actions: ["FIXTURE_INLINE"] },
      },
    ],
  ] as ActionExample[][],
};
