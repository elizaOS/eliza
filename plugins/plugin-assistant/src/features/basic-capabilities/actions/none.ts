import type {
  Action,
  ActionExample,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { hasActionContext } from "@elizaos/core";
export const noneAction: Action = {
  name: "NONE",
  contexts: ["general"],
  roleGate: { minRole: "USER" },
  similes: [...["NO_ACTION", "NO_RESPONSE", "NO_REACTION", "NOOP", "PASS"]],
  parameters: [],
  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) =>
    hasActionContext(message, state, {
      contexts: ["general"],
    }),
  description:
    "Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.",
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<ActionResult> => {
    return {
      text: "",
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
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Hey whats up",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "oh hey",
          actions: ["NONE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "did u see some faster whisper just came out",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "yeah but its a pain to get into node.js",
          actions: ["NONE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "u think aliens are real",
          actions: ["NONE"],
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Yes, probably.",
          actions: ["NONE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "drop a joke on me",
          actions: ["NONE"],
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Why don't scientists trust atoms? Because they make up everything.",
          actions: ["NONE"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
