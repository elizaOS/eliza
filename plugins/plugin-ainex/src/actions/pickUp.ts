import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getStringOption, sendOne } from "./_helpers";

export const pickUpAction: Action = {
  name: "AINEX_PICK_UP",
  similes: ["PICK_UP", "GRAB", "GRASP_OBJECT"],
  description:
    "Run the learned `pick_up` policy. Starts a policy.start with task='pick_up'; options: target_label (default 'red ball'), max_steps.",
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
        task: "pick_up",
        canonical_action: "pick_up",
        target_label: getStringOption(options, "target_label", "red ball"),
        target_entity_id: getStringOption(options, "target_entity_id", ""),
        hz: 10,
        max_steps: 1000,
      },
      "AiNex is reaching to pick up the target.",
      "pick up",
    );
  },
};
