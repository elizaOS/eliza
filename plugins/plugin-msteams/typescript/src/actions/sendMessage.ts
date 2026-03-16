import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { MSTEAMS_SERVICE_NAME, type MSTeamsService } from "../service";

export const SEND_MESSAGE_ACTION = "SEND_MSTEAMS_MESSAGE";

export const sendMessageAction: Action = {
  name: SEND_MESSAGE_ACTION,
  similes: [
    "MSTEAMS_SEND_MESSAGE",
    "MSTEAMS_REPLY",
    "MSTEAMS_MESSAGE",
    "SEND_TEAMS_MESSAGE",
    "REPLY_TEAMS",
    "TEAMS_SEND",
    "TEAMS_MESSAGE",
  ],
  description: "Send a message to a Microsoft Teams conversation",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const source = message.content?.source;
    return source === "msteams";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const msTeamsService = runtime.getService(
      MSTEAMS_SERVICE_NAME,
    ) as unknown as MSTeamsService | undefined;
    if (!msTeamsService) {
      if (callback) {
        await callback({
          text: "MS Teams service not available",
        });
      }
      return { success: false, error: "MS Teams service not initialized" };
    }

    const client = msTeamsService.getClient();
    if (!client) {
      if (callback) {
        await callback({
          text: "MS Teams client not available",
        });
      }
      return { success: false, error: "MS Teams client not initialized" };
    }

    const currentState = state ?? (await runtime.composeState(message));
    const responseText = currentState.values?.response?.toString() || "";
    const conversationId = message.content?.conversationId as
      | string
      | undefined;

    if (!conversationId) {
      if (callback) {
        await callback({
          text: "No conversation ID available",
        });
      }
      return { success: false, error: "Missing conversation ID" };
    }

    try {
      const result = await client.sendProactiveMessage(
        conversationId,
        responseText,
      );

      if (callback) {
        await callback({
          text: responseText,
          action: SEND_MESSAGE_ACTION,
        });
      }

      return {
        success: true,
        data: {
          action: SEND_MESSAGE_ACTION,
          conversationId,
          messageId: result.messageId,
          text: responseText,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (callback) {
        await callback({
          text: `Failed to send message: ${errorMessage}`,
        });
      }

      return { success: false, error: errorMessage };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a message to this Teams conversation",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send a message to this Teams chat now.",
          actions: [SEND_MESSAGE_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};

export const SEND_POLL_ACTION = "SEND_MSTEAMS_POLL";

export const sendPollAction: Action = {
  name: SEND_POLL_ACTION,
  similes: [
    "MSTEAMS_SEND_POLL",
    "MSTEAMS_CREATE_POLL",
    "TEAMS_POLL",
    "CREATE_POLL",
    "SEND_POLL",
  ],
  description: "Send a poll to a Microsoft Teams conversation",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const source = message.content?.source;
    return source === "msteams";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const msTeamsService = runtime.getService(
      MSTEAMS_SERVICE_NAME,
    ) as unknown as MSTeamsService | undefined;
    if (!msTeamsService) {
      if (callback) {
        await callback({
          text: "MS Teams service not available",
        });
      }
      return { success: false, error: "MS Teams service not initialized" };
    }

    const client = msTeamsService.getClient();
    if (!client) {
      if (callback) {
        await callback({
          text: "MS Teams client not available",
        });
      }
      return { success: false, error: "MS Teams client not initialized" };
    }

    const currentState = state ?? (await runtime.composeState(message));
    const conversationId = message.content?.conversationId as
      | string
      | undefined;
    const question = currentState.values?.pollQuestion?.toString() || "";
    const optionsRaw = currentState.values?.pollOptions;

    if (!conversationId) {
      return { success: false, error: "Missing conversation ID" };
    }

    if (!question) {
      return { success: false, error: "Missing poll question" };
    }

    // Parse options
    let options: string[] = [];
    if (Array.isArray(optionsRaw)) {
      options = optionsRaw.map((o) => String(o));
    } else if (typeof optionsRaw === "string") {
      options = optionsRaw.split(",").map((o) => o.trim());
    }

    if (options.length < 2) {
      return { success: false, error: "Poll must have at least 2 options" };
    }

    try {
      const result = await client.sendPoll(conversationId, question, options);

      if (callback) {
        await callback({
          text: `Poll created: ${question}`,
          action: SEND_POLL_ACTION,
        });
      }

      return {
        success: true,
        data: {
          action: SEND_POLL_ACTION,
          conversationId,
          pollId: result.pollId,
          messageId: result.messageId,
          question,
          options,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Create a poll asking what day works best for our meeting",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll create a poll for that.",
          actions: [SEND_POLL_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};

export const SEND_ADAPTIVE_CARD_ACTION = "SEND_MSTEAMS_CARD";

export const sendAdaptiveCardAction: Action = {
  name: SEND_ADAPTIVE_CARD_ACTION,
  similes: [
    "MSTEAMS_SEND_CARD",
    "MSTEAMS_ADAPTIVE_CARD",
    "TEAMS_CARD",
    "SEND_CARD",
  ],
  description: "Send an Adaptive Card to a Microsoft Teams conversation",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const source = message.content?.source;
    return source === "msteams";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const msTeamsService = runtime.getService(
      MSTEAMS_SERVICE_NAME,
    ) as unknown as MSTeamsService | undefined;
    if (!msTeamsService) {
      return { success: false, error: "MS Teams service not initialized" };
    }

    const client = msTeamsService.getClient();
    if (!client) {
      return { success: false, error: "MS Teams client not initialized" };
    }

    const currentState = state ?? (await runtime.composeState(message));
    const conversationId = message.content?.conversationId as
      | string
      | undefined;
    const cardContent = currentState.values?.cardContent as
      | Record<string, unknown>
      | undefined;

    if (!conversationId) {
      return { success: false, error: "Missing conversation ID" };
    }

    if (!cardContent) {
      return { success: false, error: "Missing card content" };
    }

    try {
      const cardBody = Array.isArray(cardContent.body) ? cardContent.body : [];
      const cardActions = Array.isArray(cardContent.actions)
        ? cardContent.actions
        : undefined;
      const card = {
        type: "AdaptiveCard" as const,
        version: "1.5",
        body: cardBody as unknown[],
        actions: cardActions as unknown[] | undefined,
      };

      const result = await client.sendAdaptiveCard(
        conversationId,
        card,
        currentState.values?.fallbackText?.toString(),
      );

      if (callback) {
        await callback({
          text: "Adaptive Card sent",
          action: SEND_ADAPTIVE_CARD_ACTION,
        });
      }

      return {
        success: true,
        data: {
          action: SEND_ADAPTIVE_CARD_ACTION,
          conversationId,
          messageId: result.messageId,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a card with meeting details",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send an Adaptive Card with the meeting information.",
          actions: [SEND_ADAPTIVE_CARD_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
