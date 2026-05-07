import {
  type Action,
  type ActionResult,
  logger,
  type Memory,
} from "@elizaos/core";
import { terminalActionResultData } from "./actionResultSemantics.js";
import { resolveXFeedAdapter } from "./x-feed-adapter.js";
import {
  extractRetryAfterSeconds,
  isRateLimitError,
  makeNotConfigured,
  makeRateLimited,
  readBooleanOption,
  readStringOption,
} from "./x-feed-helpers.js";

export const replyXDmAction: Action = {
  name: "REPLY_X_DM",
  similes: ["SEND_X_DM", "REPLY_TWITTER_DM", "X_DM_REPLY"],
  description:
    "Reply to a Twitter/X direct message. Two-stage: without `confirmed: true` this returns a preview and requires confirmation; with `confirmed: true` the DM is sent.",
  descriptionCompressed:
    "reply Twitter/X direct message two-stage: wo/ confirm: true return preview require confirmation; w/ confirm: true DM send",
  contexts: ["messaging", "connectors"],
  contextGate: { anyOf: ["messaging", "connectors"] },
  roleGate: { minRole: "USER" },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "recipient",
      description: "Recipient user id or username (without leading @).",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "text",
      description: "The DM body.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "confirmed",
      description: "Must be true for the DM to actually send.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Reply to @jane_doe's X DM saying I'll call tomorrow.",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Here's a draft — confirm to send.",
          action: "REPLY_X_DM",
        },
      },
    ],
  ],
  validate: async (_runtime, message: Memory) => {
    const text = (message.content?.text ?? "").toLowerCase();
    return (
      /\b(reply|respond|dm)/.test(text) && /\b(x|twitter|x\.com)\b/.test(text)
    );
  },
  handler: async (runtime, _message, _state, options) => {
    const adapter = resolveXFeedAdapter(runtime);
    if (!adapter) {
      const result = makeNotConfigured("REPLY_X_DM");
      return {
        success: false,
        text: result.text,
        data: { reason: result.reason },
      } satisfies ActionResult;
    }
    const opts = (options ?? {}) as Record<string, unknown>;
    const recipient = readStringOption(opts, "recipient");
    const text = readStringOption(opts, "text");
    const confirmed = readBooleanOption(opts, "confirmed");

    if (!recipient || !text) {
      return {
        success: false,
        text: "REPLY_X_DM requires `recipient` and `text`.",
        data: { reason: "missing-parameters" },
      } satisfies ActionResult;
    }

    const preview = `DM to ${recipient}: ${text}`;

    if (!confirmed) {
      logger.info(
        { action: "REPLY_X_DM", recipient, textLen: text.length },
        "[REPLY_X_DM] draft created — awaiting confirmation",
      );
      return {
        success: false,
        text: `Draft preview — confirm to send:\n${preview}`,
        data: {
          requiresConfirmation: true,
          preview,
          recipient,
          draftText: text,
        },
      } satisfies ActionResult;
    }

    try {
      const sent = await adapter.sendDirectMessage({ recipient, text });
      logger.info(
        { action: "REPLY_X_DM", recipient, dmId: sent.id },
        "[REPLY_X_DM] sent confirmed DM",
      );
      return {
        success: true,
        text: `Sent X DM to ${recipient}.`,
        data: terminalActionResultData({
          dmId: sent.id,
          recipient,
          sentText: text,
        }),
      } satisfies ActionResult;
    } catch (error) {
      if (isRateLimitError(error)) {
        const result = makeRateLimited(
          "REPLY_X_DM",
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
