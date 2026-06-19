// Test fixture: `examples: [...A, ...B.examples ?? [], inlinePair]`.
// Mirrors `plugins/plugin-music/src/actions/music.ts:215`'s `musicExamples`
// shape (concatenates examples from sub-actions via spread).

import type { Action, ActionExample } from "@elizaos/core";

import {
  fixtureSpreadAction,
  fixtureSpreadSourceExamples,
} from "./spread-source.action.js";

const FIXTURE_SPREAD_EXAMPLES: ActionExample[][] = [
  ...fixtureSpreadSourceExamples,
  ...(fixtureSpreadAction.examples ?? []),
  [
    {
      name: "{{name1}}",
      content: { text: "umbrella: do the thing" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "On it.",
        actions: ["FIXTURE_SPREAD"],
      },
    },
  ],
];

export const fixtureSpreadUmbrellaAction: Action = {
  name: "FIXTURE_SPREAD",
  description: "Spread-elements examples test fixture",
  validate: async () => true,
  handler: async () => undefined,
  examples: FIXTURE_SPREAD_EXAMPLES,
};
