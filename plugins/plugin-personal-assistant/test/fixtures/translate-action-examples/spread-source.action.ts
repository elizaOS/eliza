// Test fixture: source file for cross-file imports used by the spread
// fixture. Defines an exported example array + an Action whose `.examples`
// property is used via PropertyAccess.

import type { Action, ActionExample } from "@elizaos/core";

export const fixtureSpreadSourceExamples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: { text: "library: search for radiohead" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Searching the library for radiohead.",
        actions: ["FIXTURE_LIBRARY"],
      },
    },
  ],
];

export const fixtureSpreadAction: Action = {
  name: "FIXTURE_LIBRARY_INNER",
  description: "Inner action used by spread fixture",
  validate: async () => true,
  handler: async () => undefined,
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "library: list playlists" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You have 3 playlists.",
          actions: ["FIXTURE_LIBRARY"],
        },
      },
    ],
  ] as ActionExample[][],
};
