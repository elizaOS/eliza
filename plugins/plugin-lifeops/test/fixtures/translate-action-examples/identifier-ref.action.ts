// Test fixture: `examples: SOMETHING_EXAMPLES` external identifier reference.
// Mirrors `plugins/plugin-music/src/actions/music.ts:415`'s
// `examples: musicExamples` shape.

import type { Action, ActionExample } from "@elizaos/core";

const FIXTURE_IDENTIFIER_EXAMPLES: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: { text: "queue some 80s synth pop" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Finding 80s synth pop!",
        actions: ["FIXTURE_IDENTIFIER"],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "what's playing right now" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Currently playing: Strokes - Last Nite",
        actions: ["FIXTURE_IDENTIFIER"],
      },
    },
  ],
];

export const fixtureIdentifierAction: Action = {
  name: "FIXTURE_IDENTIFIER",
  description: "Identifier-reference examples test fixture",
  validate: async () => true,
  handler: async () => undefined,
  examples: FIXTURE_IDENTIFIER_EXAMPLES,
};
