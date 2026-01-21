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
import { createMessageReply, extractUrls } from "../utils";

const spec = requireActionSpec("UNSUBSCRIBE_FEED");

export const unsubscribeFeedAction: Action = {
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

  examples: (spec.examples ?? []) as ActionExample[][],
};

export default unsubscribeFeedAction;
