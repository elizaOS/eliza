/**
 * List friends action for the Zalo User plugin.
 *
 * Lists or searches friends on the Zalo personal account.
 * Maps to the classic "friends" tool action.
 */

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
import { ZALOUSER_SERVICE_NAME } from "../constants";
import type { ZaloUserService } from "../service";

export const LIST_FRIENDS_ACTION = "ZALOUSER_LIST_FRIENDS";

export const listFriendsAction: Action = {
  name: LIST_FRIENDS_ACTION,
  similes: [
    "ZALOUSER_FRIENDS",
    "ZALO_LIST_FRIENDS",
    "ZALO_FRIENDS",
    "ZALO_SEARCH_FRIENDS",
    "ZALO_FIND_FRIEND",
  ],
  description:
    "List or search friends on the Zalo personal account",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const service = await runtime.getService(ZALOUSER_SERVICE_NAME);
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = await runtime.getService(ZALOUSER_SERVICE_NAME) as
      | ZaloUserService
      | undefined;

    if (!service) {
      if (callback) {
        await callback({ text: "Zalo User service not available" });
      }
      return { success: false, error: "Zalo User service not initialized" };
    }

    const query = (message.content?.query as string) ||
      (message.content?.search as string) || undefined;

    const friends = await service.listFriends(query);

    if (friends.length === 0) {
      const msg = query
        ? `No friends found matching "${query}".`
        : "No friends found.";
      if (callback) {
        await callback({ text: msg });
      }
      return { success: true, data: { friends: [] } };
    }

    const friendList = friends
      .map(
        (f) =>
          `- ${f.displayName} (ID: ${f.userId})${f.phoneNumber ? ` [${f.phoneNumber}]` : ""}`,
      )
      .join("\n");

    const header = query
      ? `Friends matching "${query}" (${friends.length}):`
      : `Friends (${friends.length}):`;

    if (callback) {
      await callback({ text: `${header}\n${friendList}` });
    }

    return {
      success: true,
      data: {
        action: LIST_FRIENDS_ACTION,
        query,
        count: friends.length,
        friends: friends.map((f) => ({
          userId: f.userId,
          displayName: f.displayName,
          phoneNumber: f.phoneNumber,
        })),
      },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show me my Zalo friends" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here are your Zalo friends.",
          actions: [LIST_FRIENDS_ACTION],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Search for a friend named Minh on Zalo" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Searching for friends matching that name.",
          actions: [LIST_FRIENDS_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
