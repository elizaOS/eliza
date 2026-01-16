import { requireActionSpec } from "../../generated/spec-helpers.ts";
import type {
  Action,
  ActionExample,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";

// Get text content from centralized specs
const spec = requireActionSpec("IGNORE");

export const ignoreAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },
  description: spec.description,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    responses?: Memory[],
  ) => {
    if (callback && responses?.[0]?.content) {
      await callback(responses[0].content);
    }
    return {
      text: "Ignoring message",
      values: { success: true, ignored: true },
      data: { actionName: "IGNORE" },
      success: true,
    };
  },
  examples: (spec.examples ?? []) as ActionExample[][],
} as Action;
