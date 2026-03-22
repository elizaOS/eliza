/**
 * List groups action for the Zalo User plugin.
 *
 * Lists groups the Zalo personal account is a member of.
 * Maps to the classic "groups" tool action.
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

export const LIST_GROUPS_ACTION = "ZALOUSER_LIST_GROUPS";

export const listGroupsAction: Action = {
  name: LIST_GROUPS_ACTION,
  similes: [
    "ZALOUSER_GROUPS",
    "ZALO_LIST_GROUPS",
    "ZALO_GROUPS",
    "ZALO_SHOW_GROUPS",
  ],
  description: "List groups the Zalo personal account is a member of",

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

    const groups = await service.listGroups();

    if (groups.length === 0) {
      if (callback) {
        await callback({ text: "No groups found." });
      }
      return { success: true, data: { groups: [] } };
    }

    const groupList = groups
      .map(
        (g) =>
          `- ${g.name} (ID: ${g.groupId})${g.memberCount != null ? ` [${g.memberCount} members]` : ""}`,
      )
      .join("\n");

    if (callback) {
      await callback({
        text: `Groups (${groups.length}):\n${groupList}`,
      });
    }

    return {
      success: true,
      data: {
        action: LIST_GROUPS_ACTION,
        count: groups.length,
        groups: groups.map((g) => ({
          groupId: g.groupId,
          name: g.name,
          memberCount: g.memberCount,
        })),
      },
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show me my Zalo groups" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here are your Zalo groups.",
          actions: [LIST_GROUPS_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
