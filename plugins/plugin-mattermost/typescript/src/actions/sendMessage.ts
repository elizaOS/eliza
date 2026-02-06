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
import { MATTERMOST_SERVICE_NAME } from "../constants";
import type { MattermostService } from "../service";

export const SEND_MESSAGE_ACTION = "SEND_MATTERMOST_MESSAGE";

export const sendMessageAction: Action = {
  name: SEND_MESSAGE_ACTION,
  similes: [
    "MATTERMOST_SEND_MESSAGE",
    "MATTERMOST_REPLY",
    "MATTERMOST_MESSAGE",
    "SEND_MATTERMOST",
    "REPLY_MATTERMOST",
    "POST_MATTERMOST",
  ],
  description: "Send a message to a Mattermost channel or user",

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const source = message.content?.source;
    return source === "mattermost";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const mattermostService = runtime.getService(MATTERMOST_SERVICE_NAME) as
      | MattermostService
      | undefined;

    if (!mattermostService) {
      if (callback) {
        await callback({
          text: "Mattermost service not available",
        });
      }
      return { success: false, error: "Mattermost service not initialized" };
    }

    const currentState = state ?? (await runtime.composeState(message));
    const responseText = currentState.values?.response?.toString() || "";
    const channelId = message.content?.channelId;
    const metadata = message.content?.metadata as Record<string, unknown> | undefined;
    const rootId = metadata?.rootId as string | undefined;

    if (!channelId) {
      if (callback) {
        await callback({
          text: "No channel ID available",
        });
      }
      return { success: false, error: "Missing channel ID" };
    }

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
        channelId,
        text: responseText,
        rootId,
      },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a message to this Mattermost channel",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send a message to this channel now.",
          actions: [SEND_MESSAGE_ACTION],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Reply to this thread",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll reply to this thread.",
          actions: [SEND_MESSAGE_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
