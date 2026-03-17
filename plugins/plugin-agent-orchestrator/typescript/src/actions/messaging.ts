import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import type { MessagingService } from "../services/messaging-service.js";
import type {
  MessageContent,
  MessageTarget,
  MessagingChannel,
} from "../types/messaging.js";
import type { DeliveryContext } from "../types/subagent.js";

/**
 * Extracts messaging parameters from the message content.
 */
function extractMessagingParams(
  message: Memory,
  _state?: State,
): { target?: Partial<MessageTarget>; content?: Partial<MessageContent> } {
  const params = message.content?.params as
    | {
        target?: Partial<MessageTarget>;
        content?: Partial<MessageContent>;
        text?: string;
        channel?: string;
        to?: string;
        threadId?: string | number;
        replyTo?: string;
      }
    | undefined;

  if (!params) {
    return {};
  }

  // Use provided target or build from flat params
  let target: Partial<MessageTarget>;
  if (params.target) {
    target = params.target;
  } else {
    // Build target from flat params, only including defined values
    target = {};
    if (params.channel) target.channel = params.channel as MessagingChannel;
    if (params.to) target.to = params.to;
    if (params.threadId !== undefined) target.threadId = params.threadId;
    if (params.replyTo) target.replyToMessageId = params.replyTo;
  }

  // Use provided content or build from params
  let content: Partial<MessageContent>;
  if (params.content) {
    content = params.content;
  } else {
    content = {};
    const text = params.text ?? message.content?.text;
    if (text) content.text = text;
  }

  return { target, content };
}

/**
 * SEND_CROSS_PLATFORM_MESSAGE action allows agents to send messages
 * to any supported platform (Discord, Telegram, Slack, etc.).
 */
export const sendCrossPlatformMessageAction: Action = {
  name: "SEND_CROSS_PLATFORM_MESSAGE",
  similes: [
    "CROSS_PLATFORM_MESSAGE",
    "UNIFIED_SEND",
    "SEND_TO_CHANNEL",
    "RELAY_MESSAGE",
    "BROADCAST_MESSAGE",
  ],
  description:
    "Send a message to any supported platform (Discord, Telegram, Slack, WhatsApp, Twitch). " +
    "Requires specifying the target channel/platform and recipient.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Check if messaging service is available
    const messagingService = await runtime.getService("MESSAGING");
    if (!messagingService) {
      return false;
    }

    // Check if params contain minimum required fields
    const params = message.content?.params as Record<string, unknown> | undefined;
    if (!params) {
      // May still work if message text contains instructions for LLM extraction
      return true;
    }

    // If params are provided, validate they have the required structure
    const hasTarget = params.target || (params.channel && params.to);
    const hasContent = params.content || params.text || message.content?.text;
    return !!(hasTarget && hasContent);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const messagingService = (await runtime.getService("MESSAGING")) as MessagingService | undefined;

    if (!messagingService) {
      if (callback) {
        await callback({
          text: "Messaging service is not available. Please ensure the orchestrator plugin is properly configured.",
        });
      }
      return { success: false, error: "Messaging service not available" };
    }

    const { target, content } = extractMessagingParams(message, state);

    if (!target?.channel) {
      if (callback) {
        await callback({
          text: "Please specify the target channel (discord, telegram, slack, whatsapp, twitch).",
        });
      }
      return { success: false, error: "Missing target channel" };
    }

    if (!target?.to) {
      if (callback) {
        await callback({
          text: "Please specify the recipient (channel ID, chat ID, or room ID).",
        });
      }
      return { success: false, error: "Missing recipient" };
    }

    if (!content?.text) {
      if (callback) {
        await callback({
          text: "Please provide the message text to send.",
        });
      }
      return { success: false, error: "Missing message text" };
    }

    // Build send target, only including defined values
    const sendTarget: MessageTarget = {
      channel: target.channel as MessagingChannel,
      to: target.to,
    };
    if (target.threadId !== undefined) sendTarget.threadId = target.threadId;
    if (target.replyToMessageId) sendTarget.replyToMessageId = target.replyToMessageId;

    // Build send content, only including defined values
    const sendContent: MessageContent = {
      text: content.text,
    };
    if (content.attachments) sendContent.attachments = content.attachments;
    if (content.embed) sendContent.embed = content.embed;
    if (content.buttons) sendContent.buttons = content.buttons;
    if (content.disableLinkPreview !== undefined) sendContent.disableLinkPreview = content.disableLinkPreview;
    if (content.silent !== undefined) sendContent.silent = content.silent;

    const result = await messagingService.send({
      target: sendTarget,
      content: sendContent,
    });

    if (callback) {
      if (result.success) {
        const callbackData: Record<string, unknown> = {};
        if (result.messageId) callbackData.messageId = result.messageId;
        if (result.sentAt) callbackData.sentAt = result.sentAt;
        await callback({
          text: `Message sent successfully to ${target.channel}.`,
          data: callbackData,
        });
      } else {
        await callback({
          text: `Failed to send message: ${result.error}`,
        });
      }
    }

    return {
      success: result.success,
      data: result as unknown as Record<string, unknown>,
      error: result.error,
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send 'Hello from the agent!' to Discord channel 123456789",
          params: {
            channel: "discord",
            to: "123456789",
            text: "Hello from the agent!",
          },
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Message sent successfully to Discord.",
          actions: ["SEND_CROSS_PLATFORM_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a Telegram message",
          params: {
            channel: "telegram",
            to: "-1001234567890",
            text: "Automated notification from your AI assistant.",
          },
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Message sent successfully to Telegram.",
          actions: ["SEND_CROSS_PLATFORM_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * SEND_TO_DELIVERY_CONTEXT action sends a message using a delivery context
 * (typically from the subagent system).
 */
export const sendToDeliveryContextAction: Action = {
  name: "SEND_TO_DELIVERY_CONTEXT",
  similes: [
    "DELIVER_MESSAGE",
    "SEND_TO_CONTEXT",
    "ROUTE_MESSAGE",
  ],
  description:
    "Send a message using a delivery context that specifies the target channel and recipient. " +
    "Useful for routing messages back to the original requester or to a specific context.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Check if messaging service is available
    const messagingService = await runtime.getService("MESSAGING");
    if (!messagingService) {
      return false;
    }

    // Check if params contain deliveryContext
    const params = message.content?.params as Record<string, unknown> | undefined;
    if (!params?.deliveryContext) {
      return false;
    }

    // Check if there's text to send
    const hasText = params.text || message.content?.text;
    return !!hasText;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const messagingService = (await runtime.getService("MESSAGING")) as MessagingService | undefined;

    if (!messagingService) {
      if (callback) {
        await callback({
          text: "Messaging service is not available.",
        });
      }
      return { success: false, error: "Messaging service not available" };
    }

    const params = message.content?.params as
      | { deliveryContext?: DeliveryContext; text?: string }
      | undefined;

    const deliveryContext = params?.deliveryContext;
    const text = params?.text ?? message.content?.text;

    if (!deliveryContext) {
      if (callback) {
        await callback({
          text: "Please provide a delivery context with channel and recipient information.",
        });
      }
      return { success: false, error: "Missing delivery context" };
    }

    if (!text) {
      if (callback) {
        await callback({
          text: "Please provide the message text to send.",
        });
      }
      return { success: false, error: "Missing message text" };
    }

    const result = await messagingService.sendToDeliveryContext(deliveryContext, {
      text,
    });

    if (callback) {
      if (result.success) {
        const callbackData: Record<string, unknown> = {};
        if (result.messageId) callbackData.messageId = result.messageId;
        await callback({
          text: `Message delivered successfully via ${result.channel}.`,
          data: callbackData,
        });
      } else {
        await callback({
          text: `Failed to deliver message: ${result.error}`,
        });
      }
    }

    return {
      success: result.success,
      data: result as unknown as Record<string, unknown>,
      error: result.error,
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send result to delivery context",
          params: {
            deliveryContext: {
              channel: "discord",
              to: "123456789",
            },
            text: "Task completed successfully!",
          },
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Message delivered successfully via discord.",
          actions: ["SEND_TO_DELIVERY_CONTEXT"],
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * SEND_TO_ROOM action sends a message to an Eliza room.
 */
export const sendToRoomAction: Action = {
  name: "SEND_TO_ROOM",
  similes: [
    "MESSAGE_ROOM",
    "ROOM_MESSAGE",
    "NOTIFY_ROOM",
  ],
  description:
    "Send a message to an Eliza room. The room's metadata determines which platform and recipient to use.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Check if messaging service is available
    const messagingService = await runtime.getService("MESSAGING");
    if (!messagingService) {
      return false;
    }

    // Check if params contain roomId
    const params = message.content?.params as Record<string, unknown> | undefined;
    if (!params?.roomId) {
      return false;
    }

    // Check if there's text to send
    const hasText = params.text || message.content?.text;
    return !!hasText;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const messagingService = (await runtime.getService("MESSAGING")) as MessagingService | undefined;

    if (!messagingService) {
      if (callback) {
        await callback({
          text: "Messaging service is not available.",
        });
      }
      return { success: false, error: "Messaging service not available" };
    }

    const params = message.content?.params as
      | { roomId?: string; text?: string }
      | undefined;

    const roomId = params?.roomId;
    const text = params?.text ?? message.content?.text;

    if (!roomId) {
      if (callback) {
        await callback({
          text: "Please specify the room ID to send the message to.",
        });
      }
      return { success: false, error: "Missing room ID" };
    }

    if (!text) {
      if (callback) {
        await callback({
          text: "Please provide the message text to send.",
        });
      }
      return { success: false, error: "Missing message text" };
    }

    const result = await messagingService.sendToRoom(roomId as UUID, { text });

    if (callback) {
      if (result.success) {
        const callbackData: Record<string, unknown> = {};
        if (result.messageId) callbackData.messageId = result.messageId;
        await callback({
          text: `Message sent to room via ${result.channel}.`,
          data: callbackData,
        });
      } else {
        await callback({
          text: `Failed to send to room: ${result.error}`,
        });
      }
    }

    return {
      success: result.success,
      data: result as unknown as Record<string, unknown>,
      error: result.error,
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send to room",
          params: {
            roomId: "550e8400-e29b-41d4-a716-446655440000",
            text: "Hello, room!",
          },
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Message sent to room via discord.",
          actions: ["SEND_TO_ROOM"],
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * SEND_TO_SESSION action sends a message to a session by its key.
 */
export const sendToSessionMessageAction: Action = {
  name: "SEND_TO_SESSION_MESSAGE",
  similes: [
    "SESSION_MESSAGE",
    "MESSAGE_SESSION",
    "NOTIFY_SESSION",
  ],
  description:
    "Send a message to a session by its session key. The session key is mapped to an Eliza room.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Check if messaging service is available
    const messagingService = await runtime.getService("MESSAGING");
    if (!messagingService) {
      return false;
    }

    // Check if params contain sessionKey
    const params = message.content?.params as Record<string, unknown> | undefined;
    if (!params?.sessionKey) {
      return false;
    }

    // Check if there's text to send
    const hasText = params.text || message.content?.text;
    return !!hasText;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const messagingService = (await runtime.getService("MESSAGING")) as MessagingService | undefined;

    if (!messagingService) {
      if (callback) {
        await callback({
          text: "Messaging service is not available.",
        });
      }
      return { success: false, error: "Messaging service not available" };
    }

    const params = message.content?.params as
      | { sessionKey?: string; text?: string }
      | undefined;

    const sessionKey = params?.sessionKey;
    const text = params?.text ?? message.content?.text;

    if (!sessionKey) {
      if (callback) {
        await callback({
          text: "Please specify the session key to send the message to.",
        });
      }
      return { success: false, error: "Missing session key" };
    }

    if (!text) {
      if (callback) {
        await callback({
          text: "Please provide the message text to send.",
        });
      }
      return { success: false, error: "Missing message text" };
    }

    const result = await messagingService.sendToSession(sessionKey, { text });

    if (callback) {
      if (result.success) {
        const callbackData: Record<string, unknown> = {};
        if (result.messageId) callbackData.messageId = result.messageId;
        await callback({
          text: `Message sent to session via ${result.channel}.`,
          data: callbackData,
        });
      } else {
        await callback({
          text: `Failed to send to session: ${result.error}`,
        });
      }
    }

    return {
      success: result.success,
      data: result as unknown as Record<string, unknown>,
      error: result.error,
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send to session",
          params: {
            sessionKey: "agent:main:dm:user123",
            text: "Update from your subagent!",
          },
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Message sent to session via discord.",
          actions: ["SEND_TO_SESSION_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * LIST_MESSAGING_CHANNELS action lists available messaging channels.
 */
export const listMessagingChannelsAction: Action = {
  name: "LIST_MESSAGING_CHANNELS",
  similes: [
    "AVAILABLE_CHANNELS",
    "GET_CHANNELS",
    "MESSAGING_PLATFORMS",
  ],
  description: "List all available messaging channels/platforms that the agent can send messages to.",

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    // This action only requires the messaging service to be available
    const messagingService = await runtime.getService("MESSAGING");
    return !!messagingService;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const messagingService = (await runtime.getService("MESSAGING")) as MessagingService | undefined;

    if (!messagingService) {
      if (callback) {
        await callback({
          text: "Messaging service is not available.",
        });
      }
      return { success: false, error: "Messaging service not available" };
    }

    const channels = messagingService.getAvailableChannels();

    if (callback) {
      if (channels.length > 0) {
        await callback({
          text: `Available messaging channels: ${channels.join(", ")}`,
          data: { channels },
        });
      } else {
        await callback({
          text: "No messaging channels are currently available.",
          data: { channels: [] },
        });
      }
    }

    return {
      success: true,
      data: { channels },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "What messaging platforms can you use?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Available messaging channels: discord, telegram, internal",
          actions: ["LIST_MESSAGING_CHANNELS"],
        },
      },
    ],
  ] as ActionExample[][],
};
