/**
 * List spaces action for Google Chat plugin.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { GoogleChatService } from "../service.js";
import type { GoogleChatSpace } from "../types.js";
import {
  GOOGLE_CHAT_SERVICE_NAME,
  getSpaceDisplayName,
  isDirectMessage,
} from "../types.js";

export const listSpaces: Action = {
  name: "GOOGLE_CHAT_LIST_SPACES",
  similes: [
    "LIST_GOOGLE_CHAT_SPACES",
    "GCHAT_SPACES",
    "SHOW_GOOGLE_CHAT_SPACES",
  ],
  description: "List all Google Chat spaces the bot is a member of",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return message.content.source === "google-chat";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const gchatService = await runtime.getService<GoogleChatService>(
      GOOGLE_CHAT_SERVICE_NAME,
    );

    if (!gchatService || !gchatService.isConnected()) {
      if (callback) {
        callback({
          text: "Google Chat service is not available.",
          source: "google-chat",
        });
      }
      return { success: false, error: "Google Chat service not available" };
    }

    const spaces = await gchatService.getSpaces();

    if (spaces.length === 0) {
      if (callback) {
        callback({
          text: "I'm not currently in any Google Chat spaces.",
          source: message.content.source as string,
        });
      }
      return {
        success: true,
        data: { spaceCount: 0, spaces: [] },
      };
    }

    // Format space list
    const spaceLines = spaces.map((space: GoogleChatSpace) => {
      const name = getSpaceDisplayName(space);
      const type = isDirectMessage(space) ? "DM" : space.type || "SPACE";
      const threaded = space.threaded ? " (threaded)" : "";
      return `• ${name} [${type}]${threaded}`;
    });

    const responseText = `Currently in ${spaces.length} space(s):\n\n${spaceLines.join("\n")}`;

    if (callback) {
      callback({
        text: responseText,
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      data: {
        spaceCount: spaces.length,
        spaces: spaces.map((s: GoogleChatSpace) => ({
          name: s.name,
          displayName: s.displayName,
          type: s.type,
          threaded: s.threaded,
        })),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What Google Chat spaces are you in?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me check my Google Chat spaces.",
          actions: ["GOOGLE_CHAT_LIST_SPACES"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "List all spaces" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll list all the Google Chat spaces I'm in.",
          actions: ["GOOGLE_CHAT_LIST_SPACES"],
        },
      },
    ],
  ],
};
