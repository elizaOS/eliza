import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getStringOption, sendOne } from "./_helpers";

export const placeDownAction: Action = {
  name: "AINEX_PLACE_DOWN",
  similes: ["PLACE_DOWN", "PUT_DOWN", "RELEASE", "DROP"],
  description:
    "Run the learned `place_down` policy. Starts a policy.start with task='place_down'.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    return sendOne(
      runtime,
      callback,
      "policy.start",
      {
        task: "place_down",
        canonical_action: "place_down",
        target_label: getStringOption(options, "target_label", ""),
        target_entity_id: getStringOption(options, "target_entity_id", ""),
        hz: 10,
        max_steps: 1000,
      },
      "AiNex is lowering the held object.",
      "place down",
    );
  },
};
