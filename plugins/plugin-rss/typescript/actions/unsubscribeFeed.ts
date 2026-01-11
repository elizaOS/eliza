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

export const unsubscribeFeedAction: Action = {
  name: "UNSUBSCRIBE_RSS_FEED",
  similes: ["REMOVE_RSS_FEED", "UNFOLLOW_RSS_FEED", "DELETE_RSS_FEED"],
  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    return true;
  },
  description: "Unsubscribe from an RSS/Atom feed",
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    runtime.logger.log("UNSUBSCRIBE_RSS_FEED Starting handler...");

    const service = runtime.getService("RSS") as RssService;
    if (!service) {
      runtime.logger.error("RSS service not found");
      callback?.(createMessageReply(runtime, message, "RSS service is not available"));
      return { success: false, error: "RSS service not found" };
    }

    const urls = extractUrls(message.content.text || "");

    if (!urls.length) {
      runtime.logger.warn("No valid URLs found in message");
      callback?.(
        createMessageReply(
          runtime,
          message,
          "Please provide a valid RSS feed URL to unsubscribe from"
        )
      );
      return { success: false, error: "No valid URLs found" };
    }

    const url = urls[0];
    if (!url) {
      callback?.(
        createMessageReply(
          runtime,
          message,
          "Please provide a valid RSS feed URL to unsubscribe from"
        )
      );
      return { success: false, error: "No valid URLs found" };
    }
    runtime.logger.debug({ url }, "Attempting to unsubscribe from feed");

    // Unsubscribe from the feed
    const success = await service.unsubscribeFeed(url);

    if (success) {
      callback?.(createMessageReply(runtime, message, `Successfully unsubscribed from ${url}`));
    } else {
      callback?.(
        createMessageReply(
          runtime,
          message,
          `Unable to unsubscribe from ${url}. You may not be subscribed to this feed.`
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
          text: "Unsubscribe from https://example.com/feed.rss",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll unsubscribe from that RSS feed for you",
          actions: ["UNSUBSCRIBE_RSS_FEED"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Remove this feed: https://news.ycombinator.com/rss",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Removing the RSS feed",
          actions: ["UNSUBSCRIBE_RSS_FEED"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default unsubscribeFeedAction;
