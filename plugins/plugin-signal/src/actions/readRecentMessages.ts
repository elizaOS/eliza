import type {
  Action,
  ActionExample,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  getMessageText,
  getSignalService,
  hasSignalService,
  hasStructuredSignalInvocation,
  isSignalConversation,
} from "./action-utils";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export const readRecentMessages: Action = {
  name: "SIGNAL_READ_RECENT_MESSAGES",
  similes: [
    "READ_SIGNAL_MESSAGES",
    "CHECK_SIGNAL_MESSAGES",
    "SHOW_SIGNAL_MESSAGES",
    "SIGNAL_INBOX",
  ],
  description: "Read the most recent Signal messages across active conversations",
  descriptionCompressed: "Read recent Signal msgs.",
  contexts: ["phone", "messaging", "connectors"],
  contextGate: { anyOf: ["phone", "messaging", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "limit",
      description: "Maximum recent messages to return.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 25, default: 10 },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!hasSignalService(runtime)) {
      return false;
    }

    if (isSignalConversation(message)) {
      return true;
    }

    if (hasStructuredSignalInvocation(message, "SIGNAL_READ_RECENT_MESSAGES", ["limit"])) {
      return true;
    }

    const text = getMessageText(message);
    return (
      /\bsignal\b/i.test(text) &&
      /\b(message|messages|inbox|recent|latest|thread|threads|chat)\b/i.test(text)
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const signalService = getSignalService(runtime);

    if (!signalService || !signalService.isServiceConnected()) {
      await callback?.({
        text: "Signal service is not available.",
        source: "signal",
      });
      return { success: false, error: "Signal service not available" };
    }

    const requestedLimit = Number(
      options?.parameters && typeof options.parameters === "object"
        ? (options.parameters as Record<string, unknown>).limit
        : DEFAULT_LIMIT
    );
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(1, requestedLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const recentMessages = await signalService.getRecentMessages(limit);
    if (recentMessages.length === 0) {
      const emptyResponse: Content = {
        text: "No recent Signal messages were found.",
        source: message.content.source || "signal",
      };
      await callback?.(emptyResponse);
      return {
        success: true,
        data: {
          messageCount: 0,
          messages: [],
        },
      };
    }

    const formattedMessages = recentMessages.map((entry, index) => {
      const timestamp = new Date(entry.createdAt).toISOString().slice(0, 16);
      return `${index + 1}. [${timestamp}] ${entry.speakerName} in ${entry.roomName}: ${entry.text}`;
    });

    const response: Content = {
      text: `Latest Signal messages:\n\n${formattedMessages.join("\n")}`,
      source: message.content.source || "signal",
    };

    await callback?.(response);

    return {
      success: true,
      data: {
        messageCount: recentMessages.length,
        messages: recentMessages,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Check my Signal messages",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll pull the latest Signal messages.",
          actions: ["SIGNAL_READ_RECENT_MESSAGES"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default readRecentMessages;
