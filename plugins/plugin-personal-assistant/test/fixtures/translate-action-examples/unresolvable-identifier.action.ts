// Test fixture: an Identifier reference whose declaration has an
// unresolvable initializer (a function call). The harness should fail loud
// rather than silently dropping the action.

import type { Action, ActionExample } from "@elizaos/core";

declare function unknownProvider(): ActionExample[][];

const FIXTURE_UNRESOLVABLE = unknownProvider();

export const fixtureUnresolvableAction: Action = {
  name: "FIXTURE_UNRESOLVABLE",
  description: "Unresolvable-identifier test fixture",
  validate: async () => true,
  handler: async () => undefined,
  examples: FIXTURE_UNRESOLVABLE,
};
