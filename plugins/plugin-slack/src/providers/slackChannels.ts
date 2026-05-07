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

const RELEVANCE_KEYWORDS = ["slack", "channel", "channels", "list"] as const;
const RELEVANCE_REGEX = /\b(?:slack|channels?|list)\b/i;
const CHANNEL_LIMIT = 50;
const TEXT_LIMIT = 120;

interface SlackChannelEntry {
  id: string;
  name: string;
  isPrivate: boolean;
  numMembers: number;
  topic: string;
  purpose: string;
}

export const slackChannelsProvider: Provider = {
  name: "slackChannels",
  description:
    "Lists non-archived public and private Slack channels in the workspace with member counts and topics.",
  descriptionCompressed: "Slack channels (public/private, members, topics).",
  dynamic: true,
  contexts: ["messaging", "connectors"],
  contextGate: { anyOf: ["messaging", "connectors"] },
  cacheScope: "conversation",
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
      const channels = await slackService.listChannels({
        types: "public_channel,private_channel",
        limit: CHANNEL_LIMIT,
      });

      const sorted = channels
        .filter((ch) => !ch.isArchived)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, CHANNEL_LIMIT);

      const entries: SlackChannelEntry[] = sorted.map((ch) => ({
        id: ch.id,
        name: ch.name,
        isPrivate: ch.isPrivate,
        numMembers: ch.numMembers ?? 0,
        topic: (ch.topic?.value ?? "").slice(0, TEXT_LIMIT),
        purpose: (ch.purpose?.value ?? "").slice(0, TEXT_LIMIT),
      }));

      return {
        data: {
          channelCount: entries.length,
          channels: entries,
        },
        values: {
          channelCount: entries.length,
        },
        text: JSON.stringify({
          slack_channels: {
            count: entries.length,
            items: entries,
          },
        }),
      };
    } catch (error) {
      return {
        data: {
          channelCount: 0,
          channels: [],
          error: error instanceof Error ? error.message : String(error),
        },
        values: {
          channelCount: 0,
          slackChannelsAvailable: false,
        },
        text: JSON.stringify({
          slack_channels: {
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
          },
        }),
      };
    }
  },
};

export default slackChannelsProvider;
