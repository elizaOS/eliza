import type {
  Action,
  ActionExample,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { SignalService } from "../service";
import { SIGNAL_SERVICE_NAME } from "../types";

export const listGroups: Action = {
  name: "SIGNAL_LIST_GROUPS",
  similes: ["LIST_SIGNAL_GROUPS", "SHOW_GROUPS", "GET_GROUPS", "SIGNAL_GROUPS"],
  description: "List Signal groups",
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return message.content.source === "signal";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const signalService = await runtime.getService(
      SIGNAL_SERVICE_NAME,
    ) as SignalService;

    if (!signalService || !signalService.isServiceConnected()) {
      await callback?.({
        text: "Signal service is not available.",
        source: "signal",
      });
      return { success: false, error: "Signal service not available" };
    }

    const groups = await signalService.getGroups();

    // Filter to groups the bot is a member of and sort by name
    const activeGroups = groups
      .filter((g) => g.isMember && !g.isBlocked)
      .sort((a, b) => a.name.localeCompare(b.name));

    // Format group list
    const groupList = activeGroups.map((g) => {
      const memberCount = g.members.length;
      const description = g.description
        ? ` - ${g.description.slice(0, 50)}${g.description.length > 50 ? "..." : ""}`
        : "";
      return `• ${g.name} (${memberCount} members)${description}`;
    });

    const response: Content = {
      text: `Found ${activeGroups.length} groups:\n\n${groupList.join("\n")}`,
      source: message.content.source,
    };

    runtime.logger.debug(
      {
        src: "plugin:signal:action:list-groups",
        groupCount: activeGroups.length,
      },
      "[SIGNAL_LIST_GROUPS] Groups listed",
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        groupCount: activeGroups.length,
        groups: activeGroups.map((g) => ({
          id: g.id,
          name: g.name,
          description: g.description,
          memberCount: g.members.length,
        })),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me my Signal groups",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll list your Signal groups.",
          actions: ["SIGNAL_LIST_GROUPS"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default listGroups;
