import {
  type Action,
  type ActionResult,
  logger,
  type Memory,
} from "@elizaos/core";
import { resolveXFeedAdapter } from "./x-feed-adapter.js";
import {
  extractRetryAfterSeconds,
  isRateLimitError,
  makeNotConfigured,
  makeRateLimited,
  readNumberOption,
} from "./x-feed-helpers.js";

const DEFAULT_LIMIT = 20;

export const readUnreadXDmsAction: Action = {
  name: "READ_UNREAD_X_DMS",
  similes: ["READ_X_DMS", "GET_X_UNREAD_DMS", "CHECK_X_DMS"],
  description: "List unread Twitter/X direct messages.",
  descriptionCompressed: "list unread Twitter/X direct message",
  examples: [
    [
      { name: "{{user1}}", content: { text: "Any unread X DMs?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Checking your unread X DMs.",
          action: "READ_UNREAD_X_DMS",
        },
      },
    ],
  ],
  validate: async (_runtime, message: Memory) => {
    const text = (message.content?.text ?? "").toLowerCase();
    return (
      /\b(dm|direct message|message)/.test(text) &&
      /\b(x|twitter|x\.com)\b/.test(text)
    );
  },
  handler: async (runtime, _message, _state, options) => {
    const adapter = resolveXFeedAdapter(runtime);
    if (!adapter) {
      const result = makeNotConfigured("READ_UNREAD_X_DMS");
      return {
        success: false,
        text: result.text,
        data: { reason: result.reason },
      } satisfies ActionResult;
    }
    const limit =
      readNumberOption(options as Record<string, unknown>, "limit") ??
      DEFAULT_LIMIT;

    try {
      const messages = await adapter.listDirectMessages({
        onlyUnread: true,
        limit,
      });
      const unread = messages.filter((m) => !m.read);
      logger.info(
        {
          action: "READ_UNREAD_X_DMS",
          total: messages.length,
          unread: unread.length,
        },
        "[READ_UNREAD_X_DMS] listed X DMs",
      );
      return {
        success: true,
        text:
          unread.length === 0
            ? "No unread X DMs."
            : `You have ${unread.length} unread X DM(s).`,
        data: { messages: unread, total: messages.length },
      } satisfies ActionResult;
    } catch (error) {
      if (isRateLimitError(error)) {
        const result = makeRateLimited(
          "READ_UNREAD_X_DMS",
          extractRetryAfterSeconds(error),
        );
        return {
          success: false,
          text: result.text,
          data: {
            reason: result.reason,
            retryAfterSeconds: result.retryAfterSeconds,
          },
        } satisfies ActionResult;
      }
      throw error;
    }
  },
};
