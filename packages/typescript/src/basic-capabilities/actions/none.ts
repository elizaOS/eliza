import { requireActionSpec } from "../../generated/spec-helpers.ts";
import type {
  Action,
  ActionExample,
  ActionResult,
  IAgentRuntime,
  Memory,
} from "../../types/index.ts";

// Get text content from centralized specs
const spec = requireActionSpec("NONE");

export const noneAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },
  description: spec.description,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<ActionResult> => {
    return {
      text: "No additional action taken",
      values: {
        success: true,
        actionType: "NONE",
      },
      data: {
        actionName: "NONE",
        description: "Response without additional action",
      },
      success: true,
    };
  },
  examples: (spec.examples ?? []) as ActionExample[][],
} as Action;
