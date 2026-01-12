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
import { createUniqueUuid, MemoryType } from "@elizaos/core";
import type { RssService } from "../service";
import { createMessageReply, extractUrls } from "../utils";

export const getFeedAction: Action = {
  name: "GET_NEWSFEED",
  similes: ["FETCH_RSS", "READ_FEED", "DOWNLOAD_FEED"],
  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    return true;
  },
  description: "Download and parse an RSS/Atom feed from a URL",
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    runtime.logger.log("GET_NEWSFEED Starting handler...");

    const service = runtime.getService("RSS") as RssService;
    if (!service) {
      runtime.logger.error("RSS service not found");
      callback?.(createMessageReply(runtime, message, "RSS service is not available"));
      return { success: false, error: "RSS service not found" };
    }

    const urls = extractUrls(message.content.text || "");
    const validUrls = urls.filter(
      (u) => u.match(/rss|feed|atom|xml/i) || u.endsWith(".rss") || u.endsWith(".xml")
    );

    if (!validUrls.length) {
      if (urls.length > 0) {
        validUrls.push(urls[0]);
      } else {
        runtime.logger.warn("No valid URLs found in message");
        callback?.(createMessageReply(runtime, message, "No valid RSS feed URL provided"));
        return { success: false, error: "No valid RSS feed URL provided" };
      }
    }

    const url = validUrls[0];
    if (!url) {
      callback?.(createMessageReply(runtime, message, "No valid RSS feed URL provided"));
      return { success: false, error: "No valid RSS feed URL provided" };
    }
    const res = await service.fetchUrl(url);

    if (!res) {
      runtime.logger.error({ url }, "Failed to fetch RSS feed");
      callback?.(createMessageReply(runtime, message, "Failed to fetch RSS feed"));
      return { success: false, error: "Failed to fetch RSS feed" };
    }

    runtime.logger.info(
      { count: res.items.length, title: res.title || url },
      "Fetched items from RSS feed"
    );

    let newItemCount = 0;

    for (const item of res.items) {
      const primaryId = createUniqueUuid(runtime, `${url}_${item.guid}`);
      const fallbackId = createUniqueUuid(runtime, `${url}_${item.title}_${item.pubDate}`);

      const existingByGuid = await runtime.getMemoriesByIds([primaryId], "feeditems");
      const existingByTitleDate = await runtime.getMemoriesByIds([fallbackId], "feeditems");

      if (
        (!existingByGuid || existingByGuid.length === 0) &&
        (!existingByTitleDate || existingByTitleDate.length === 0)
      ) {
        const itemId = item.guid ? primaryId : fallbackId;

        const itemMemory: Memory = {
          id: itemId,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          content: {
            text: item.title,
            url: item.link,
          },
          roomId: message.roomId,
          createdAt: Date.now(),
          metadata: {
            type: MemoryType.CUSTOM,
            feedUrl: url,
            feedTitle: res.title,
            title: item.title,
            link: item.link,
            pubDate: item.pubDate,
            description: item.description,
            author: item.author,
            category: item.category.join(","),
            comments: item.comments,
            guid: item.guid,
          },
        };

        await runtime.createMemory(itemMemory, "feeditems");
        newItemCount++;
      }
    }

    if (url) {
      await service.subscribeFeed(url, res.title);
    }

    const responseText =
      newItemCount > 0
        ? `Downloaded ${res.items.length} articles from "${res.title}", ${newItemCount} new items stored. Feed auto-subscribed for periodic updates.`
        : `Downloaded ${res.items.length} articles from "${res.title}", all items already stored. Feed auto-subscribed for periodic updates.`;

    callback?.(createMessageReply(runtime, message, responseText));
    return { success: true };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Read https://server.com/feed.rss",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll check that out",
          actions: ["GET_NEWSFEED"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Fetch the news from https://news.ycombinator.com/rss",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Fetching the Hacker News feed now",
          actions: ["GET_NEWSFEED"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default getFeedAction;
