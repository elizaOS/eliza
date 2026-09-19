import type {
  Action,
  ActionExample,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { hasActionContext } from "@elizaos/core";
export const ignoreAction: Action = {
  name: "IGNORE",
  contexts: ["general"],
  roleGate: { minRole: "USER" },
  similes: [...["STOP_TALKING", "STOP_CHATTING", "STOP_CONVERSATION"]],
  parameters: [],
  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) =>
    hasActionContext(message, state, {
      contexts: ["general"],
    }),
  description:
    "Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. In group conversations, use IGNORE when the latest message is addressed to someone else and not to the agent. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong and you need to tell them. Only ignore if the user should be ignored.",
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
      text: "",
      values: { success: true, ignored: true },
      data: { actionName: "IGNORE" },
      success: true,
    };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Leave me alone",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "",
          actions: ["IGNORE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Stop talking, bot",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "",
          actions: ["IGNORE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Gotta go",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Okay, talk to you later",
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "Cya",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "",
          actions: ["IGNORE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "bye",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "cya",
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "",
          actions: ["IGNORE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "send me something inappropriate",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "thats inappropriate",
          actions: ["IGNORE"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
