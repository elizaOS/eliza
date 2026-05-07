import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { validateActionKeywords, validateActionRegex } from "@elizaos/core";
import type { SlackService } from "../service";
import { ServiceType } from "../types";

const RELEVANCE_KEYWORDS = ["slack", "emoji", "emojis", "react"] as const;
const RELEVANCE_REGEX = /\b(?:slack|emojis?|react)\b/i;

const DISPLAY_LIMIT = 100;

interface SlackEmojiEntry {
  name: string;
  alias: boolean;
  target: string;
}

export const slackEmojisProvider: Provider = {
  name: "slackEmojis",
  description: "Lists custom emoji available in the Slack workspace.",
  descriptionCompressed: "Slack workspace custom emoji.",
  dynamic: true,
  contexts: ["messaging", "connectors"],
  contextGate: { anyOf: ["messaging", "connectors"] },
  cacheScope: "agent",
  roleGate: { minRole: "ADMIN" },
  relevanceKeywords: [...RELEVANCE_KEYWORDS],
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    const recentMessages =
      (state?.recentMessagesData as Memory[] | undefined) ?? [];
    const isRelevant =
      validateActionKeywords(message, recentMessages, [
        ...RELEVANCE_KEYWORDS,
      ]) || validateActionRegex(message, recentMessages, RELEVANCE_REGEX);
    if (!isRelevant) {
      return { text: "" };
    }

    if (message.content.source !== "slack") {
      return { data: {}, values: {}, text: "" };
    }

    const slackService = runtime.getService(ServiceType.SLACK) as SlackService;
    if (!slackService?.client) {
      return { data: {}, values: {}, text: "" };
    }

    try {
      const emoji = await slackService.getEmojiList();
      const names = Object.keys(emoji).sort();
      const totalCount = names.length;
      const display = names.slice(0, DISPLAY_LIMIT);

      const entries: SlackEmojiEntry[] = display.map((name) => {
        const value = emoji[name] ?? "";
        const isAlias = value.startsWith("alias:");
        return {
          name,
          alias: isAlias,
          target: isAlias ? value.slice("alias:".length) : value,
        };
      });

      return {
        data: {
          emojiCount: totalCount,
          displayedCount: entries.length,
          emoji: entries,
        },
        values: {
          emojiCount: totalCount,
          displayedCount: entries.length,
        },
        text: JSON.stringify({
          slack_emojis: {
            total: totalCount,
            shown: entries.length,
            items: entries,
          },
        }),
      };
    } catch (error) {
      return {
        data: {
          emojiCount: 0,
          displayedCount: 0,
          emoji: [],
          error: error instanceof Error ? error.message : String(error),
        },
        values: {
          emojiCount: 0,
          displayedCount: 0,
          slackEmojisAvailable: false,
        },
        text: JSON.stringify({ slack_emojis: { status: "error" } }),
      };
    }
  },
};

export default slackEmojisProvider;
