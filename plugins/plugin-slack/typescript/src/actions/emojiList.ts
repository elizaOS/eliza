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
import type { SlackService } from "../service";
import { SLACK_SERVICE_NAME } from "../types";

export const emojiList: Action = {
  name: "SLACK_EMOJI_LIST",
  similes: [
    "LIST_SLACK_EMOJI",
    "SHOW_EMOJI",
    "GET_CUSTOM_EMOJI",
    "CUSTOM_EMOJI",
    "WORKSPACE_EMOJI",
  ],
  description: "List custom emoji available in the Slack workspace",
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return message.content.source === "slack";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const slackService = runtime.getService(SLACK_SERVICE_NAME) as SlackService;

    if (!slackService || !slackService.client) {
      await callback?.({
        text: "Slack service is not available.",
        source: "slack",
      });
      return { success: false, error: "Slack service not available" };
    }

    const emoji = await slackService.getEmojiList();
    const emojiNames = Object.keys(emoji).sort();

    if (emojiNames.length === 0) {
      const response: Content = {
        text: "There are no custom emoji in this workspace.",
        source: message.content.source,
      };
      await callback?.(response);

      return {
        success: true,
        data: {
          emojiCount: 0,
          emoji: {},
        },
      };
    }

    // Group emoji into chunks for display
    const _chunkSize = 20;
    const displayCount = Math.min(emojiNames.length, 100);
    const displayEmoji = emojiNames.slice(0, displayCount);

    // Detect aliases (emoji that reference other emoji with "alias:")
    const aliases: string[] = [];
    const custom: string[] = [];

    for (const name of displayEmoji) {
      const value = emoji[name];
      if (value.startsWith("alias:")) {
        aliases.push(name);
      } else {
        custom.push(name);
      }
    }

    const emojiDisplay = custom.map((name) => `:${name}:`).join(" ");
    const aliasDisplay =
      aliases.length > 0
        ? `\n\nAliases: ${aliases.map((name) => `:${name}:`).join(" ")}`
        : "";

    const truncationNote =
      emojiNames.length > displayCount
        ? `\n\n(Showing ${displayCount} of ${emojiNames.length} total custom emoji)`
        : "";

    const response: Content = {
      text: `Custom emoji in this workspace (${emojiNames.length} total):\n\n${emojiDisplay}${aliasDisplay}${truncationNote}`,
      source: message.content.source,
    };

    runtime.logger.debug(
      {
        src: "plugin:slack:action:emoji-list",
        emojiCount: emojiNames.length,
      },
      "[SLACK_EMOJI_LIST] Emoji listed",
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        emojiCount: emojiNames.length,
        emoji: Object.fromEntries(
          displayEmoji.map((name) => [name, emoji[name]]),
        ),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me the custom emoji in this workspace",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll list the custom emoji available.",
          actions: ["SLACK_EMOJI_LIST"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "What emoji can I use here?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me show you the custom emoji in this workspace.",
          actions: ["SLACK_EMOJI_LIST"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default emojiList;
