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
  contexts: ["social", "connectors"],
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

    const channels = await slackService.listChannels({
      types: "public_channel,private_channel",
      limit: 100,
    });

    const sorted = channels
      .filter((ch) => !ch.isArchived)
      .sort((a, b) => a.name.localeCompare(b.name));

    const entries: SlackChannelEntry[] = sorted.map((ch) => ({
      id: ch.id,
      name: ch.name,
      isPrivate: ch.isPrivate,
      numMembers: ch.numMembers ?? 0,
      topic: ch.topic?.value ?? "",
      purpose: ch.purpose?.value ?? "",
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
  },
};

export default slackChannelsProvider;
