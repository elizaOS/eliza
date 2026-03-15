/**
 * Get profile action for the Zalo User plugin.
 *
 * Gets the authenticated Zalo user's profile information.
 * Maps to the classic "me" tool action.
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

export const GET_PROFILE_ACTION = "ZALOUSER_GET_PROFILE";

export const getProfileAction: Action = {
  name: GET_PROFILE_ACTION,
  similes: [
    "ZALOUSER_ME",
    "ZALOUSER_PROFILE",
    "ZALO_ME",
    "ZALO_PROFILE",
    "ZALO_WHO_AM_I",
    "ZALO_MY_INFO",
  ],
  description:
    "Get the authenticated Zalo personal account profile information",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const service = await runtime.getService(ZALOUSER_SERVICE_NAME);
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
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

    const user = service.getCurrentUser();

    if (!user) {
      if (callback) {
        await callback({
          text: "Not currently authenticated with Zalo. Run QR login first.",
        });
      }
      return { success: false, error: "Not authenticated" };
    }

    const lines: string[] = [
      "Zalo Profile:",
      `  Display Name: ${user.displayName}`,
      `  User ID: ${user.userId}`,
    ];

    if (user.avatar) {
      lines.push(`  Avatar: ${user.avatar}`);
    }

    if (user.phoneNumber) {
      lines.push(`  Phone: ${user.phoneNumber}`);
    }

    if (callback) {
      await callback({ text: lines.join("\n") });
    }

    return {
      success: true,
      data: {
        action: GET_PROFILE_ACTION,
        userId: user.userId,
        displayName: user.displayName,
        avatar: user.avatar,
        phoneNumber: user.phoneNumber,
      },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "What's my Zalo profile?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here's your Zalo profile information.",
          actions: [GET_PROFILE_ACTION],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Who am I on Zalo?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Let me check your Zalo account.",
          actions: [GET_PROFILE_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
