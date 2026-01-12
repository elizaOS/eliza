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
import type { RssService } from "../service";
import { createMessageReply, extractUrls } from "../utils";

export const subscribeFeedAction: Action = {
  name: "SUBSCRIBE_RSS_FEED",
  similes: ["ADD_RSS_FEED", "FOLLOW_RSS_FEED", "SUBSCRIBE_TO_RSS"],
  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    return true;
  },
  description: "Subscribe to an RSS/Atom feed for automatic monitoring",
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    const service = runtime.getService("RSS") as RssService;
    if (!service) {
      runtime.logger.error("RSS service not found");
      callback?.(createMessageReply(runtime, message, "RSS service is not available"));
      return { success: false, error: "RSS service not found" };
    }

    const urls = extractUrls(message.content.text || "");

    if (!urls.length) {
      runtime.logger.warn("No valid URLs found in message");
      callback?.(createMessageReply(runtime, message, "Please provide a valid RSS feed URL"));
      return { success: false, error: "No valid URLs found" };
    }

    const url = urls[0];
    if (!url) {
      callback?.(createMessageReply(runtime, message, "Please provide a valid RSS feed URL"));
      return { success: false, error: "No valid URLs found" };
    }
    runtime.logger.debug({ url }, "Attempting to subscribe to feed");

    const feedData = await service.fetchUrl(url);

    if (!feedData || !feedData.items) {
      runtime.logger.error({ url }, "Invalid or empty RSS feed");
      callback?.(
        createMessageReply(
          runtime,
          message,
          `Unable to fetch RSS feed from ${url}. Please check the URL and try again.`
        )
      );
      return { success: false, error: "Invalid or empty RSS feed" };
    }

    const success = await service.subscribeFeed(url, feedData.title);

    if (success) {
      const itemCount = feedData.items?.length || 0;
      callback?.(
        createMessageReply(
          runtime,
          message,
          `Successfully subscribed to "${feedData.title}" (${url}). Found ${itemCount} items in the feed.`
        )
      );
    } else {
      callback?.(
        createMessageReply(
          runtime,
          message,
          `Failed to subscribe to ${url}. You may already be subscribed to this feed.`
        )
      );
    }
    return { success };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Subscribe to https://example.com/feed.rss",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll subscribe to that RSS feed for you",
          actions: ["SUBSCRIBE_RSS_FEED"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Add this feed: https://news.ycombinator.com/rss",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Adding the RSS feed",
          actions: ["SUBSCRIBE_RSS_FEED"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default subscribeFeedAction;
