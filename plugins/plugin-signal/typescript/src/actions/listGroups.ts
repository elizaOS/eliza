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
import {
  getMessageText,
  getSignalService,
  hasSignalService,
  hasStructuredSignalInvocation,
  isSignalConversation,
} from "./action-utils";

export const listGroups: Action = {
  name: "SIGNAL_LIST_GROUPS",
  similes: ["LIST_SIGNAL_GROUPS", "SHOW_GROUPS", "GET_GROUPS", "SIGNAL_GROUPS"],
  description: "List Signal groups",
  descriptionCompressed: "List Signal groups.",
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!hasSignalService(runtime)) {
      return false;
    }

    if (isSignalConversation(message)) {
      return true;
    }

    if (hasStructuredSignalInvocation(message, "SIGNAL_LIST_GROUPS")) {
      return true;
    }

    const text = getMessageText(message);
    return /\bsignal\b/i.test(text) && /\b(group|groups)\b/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
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
      source: message.content.source || "signal",
    };

    runtime.logger.debug(
      {
        src: "plugin:signal:action:list-groups",
        groupCount: activeGroups.length,
      },
      "[SIGNAL_LIST_GROUPS] Groups listed"
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
