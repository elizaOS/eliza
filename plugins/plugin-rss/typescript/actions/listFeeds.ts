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
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { RssService } from "../service";
import type { FeedSubscriptionMetadata } from "../types";
import { createMessageReply, formatRelativeTime } from "../utils";

const spec = requireActionSpec("LIST_FEEDS");

export const listFeedsAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    return true;
  },
  description: spec.description,
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

    const feeds = await service.getSubscribedFeeds();

    if (!feeds || feeds.length === 0) {
      callback?.(
        createMessageReply(
          runtime,
          message,
          "No RSS feeds are currently subscribed. Use the subscribe action to add feeds."
        )
      );
      return { success: true };
    }

    let feedList = `You are subscribed to ${feeds.length} RSS feed${feeds.length > 1 ? "s" : ""}:\n\n`;

    feeds.forEach((feed, index) => {
      const title = feed.content.text || "Untitled Feed";
      const url = feed.content.url || "Unknown URL";
      const metadata = feed.metadata as FeedSubscriptionMetadata;
      const lastChecked = metadata?.lastChecked;
      const itemCount = metadata?.lastItemCount || 0;

      feedList += `${index + 1}. ${title}\n`;
      feedList += `   URL: ${url}\n`;

      if (lastChecked && lastChecked > 0) {
        const timeStr = formatRelativeTime(lastChecked);
        feedList += `   Last checked: ${timeStr} (${itemCount} items)\n`;
      } else {
        feedList += `   Last checked: Never\n`;
      }

      feedList += "\n";
    });

    callback?.(createMessageReply(runtime, message, feedList.trim()));
    return { success: true };
  },

  examples: (spec.examples ?? []) as ActionExample[][],
};

export default listFeedsAction;
