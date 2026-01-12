import { logger } from "../../logger.ts";
import { replyTemplate } from "../../prompts.ts";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { composePromptFromState, parseKeyValueXml } from "../../utils.ts";

/**
 * Represents an action that allows the agent to reply to the current conversation with a generated message.
 *
 * This action can be used as an acknowledgement at the beginning of a chain of actions, or as a final response at the end of a chain of actions.
 *
 * @typedef {Object} replyAction
 * @property {string} name - The name of the action ("REPLY").
 * @property {string[]} similes - An array of similes for the action.
 * @property {string} description - A description of the action and its usage.
 * @property {Function} validate - An asynchronous function for validating the action runtime.
 * @property {Function} handler - An asynchronous function for handling the action logic.
 * @property {ActionExample[][]} examples - An array of example scenarios for the action.
 */
export const replyAction = {
  name: "REPLY",
  similes: ["GREET", "REPLY_TO_MESSAGE", "SEND_REPLY", "RESPOND", "RESPONSE"],
  description:
    "Replies to the current conversation with the text from the generated message. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response.",
  validate: async (_runtime: IAgentRuntime) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    responses?: Memory[],
  ): Promise<ActionResult> => {
    // Access previous action results from context if available
    const actionContext = _options?.actionContext;
    const previousResults = actionContext?.previousResults || [];

    if (previousResults.length > 0) {
      logger.debug(
        {
          src: "plugin:bootstrap:action:reply",
          agentId: runtime.agentId,
          count: previousResults.length,
        },
        "Found previous action results",
      );
    }

    // Check if any responses had providers associated with them
    const allProviders =
      responses?.flatMap((res) => res.content?.providers || []) || [];

    // Only generate response using LLM if no suitable response was found
    state = await runtime.composeState(message, [
      ...(allProviders ?? []),
      "RECENT_MESSAGES",
      "ACTION_STATE",
    ]);

    const prompt = composePromptFromState({
      state,
      template: runtime.character.templates?.replyTemplate || replyTemplate,
    });

    // Streaming is automatic via streaming context (set by MessageService)
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    });

    // Parse XML response
    const parsedXml = parseKeyValueXml(response);
    const thoughtValue = parsedXml?.thought;
    const textValue = parsedXml?.text;
    const thought: string =
      typeof thoughtValue === "string" ? thoughtValue : "";
    const text: string = typeof textValue === "string" ? textValue : "";

    const responseContent = {
      thought,
      text,
      actions: ["REPLY"] as string[],
    };

    if (callback) {
      await callback(responseContent);
    }

    return {
      text: `Generated reply: ${responseContent.text}`,
      values: {
        success: true,
        responded: true,
        lastReply: responseContent.text,
        lastReplyTime: Date.now(),
        thoughtProcess: thought,
      },
      data: {
        actionName: "REPLY",
        responseThought: thought,
        responseText: text,
        thought,
        messageGenerated: true,
      },
      success: true,
    };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Hello there!",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Hi! How can I help you today?",
          actions: ["REPLY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What's your favorite color?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I really like deep shades of blue. They remind me of the ocean and the night sky.",
          actions: ["REPLY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you explain how neural networks work?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Let me break that down for you in simple terms...",
          actions: ["REPLY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Could you help me solve this math problem?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Of course! Let's work through it step by step.",
          actions: ["REPLY"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
