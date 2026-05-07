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

const RELEVANCE_KEYWORDS = ["slack", "pin", "pins", "pinned"] as const;
const RELEVANCE_REGEX = /\b(?:slack|pins?|pinned)\b/i;

const TEXT_PREVIEW_LIMIT = 100;

interface SlackPinEntry {
  ts: string;
  user: string;
  text: string;
  truncated: boolean;
}

export const slackPinsProvider: Provider = {
  name: "slackPins",
  description: "Lists pinned messages in the current Slack channel.",
  descriptionCompressed: "List pinned Slack channel msgs.",
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

    const room = state.data?.room ?? (await runtime.getRoom(message.roomId));
    const channelId = room?.channelId;
    if (!channelId) {
      return { data: {}, values: {}, text: "" };
    }

    const channel = await slackService.getChannel(channelId);
    const channelName = channel?.name ?? channelId;

    const pins = await slackService.listPins(channelId);

    const entries: SlackPinEntry[] = pins.map((pin) => {
      const fullText = pin.text ?? "";
      const truncated = fullText.length > TEXT_PREVIEW_LIMIT;
      return {
        ts: pin.ts,
        user: pin.user ?? "unknown",
        text: truncated ? fullText.slice(0, TEXT_PREVIEW_LIMIT) : fullText,
        truncated,
      };
    });

    return {
      data: {
        channelId,
        channelName,
        pinCount: entries.length,
        pins: entries,
      },
      values: {
        channelId,
        channelName,
        pinCount: entries.length,
      },
      text: JSON.stringify({
        slack_pins: {
          channel: channelName,
          count: entries.length,
          items: entries,
        },
      }),
    };
  },
};

export default slackPinsProvider;
