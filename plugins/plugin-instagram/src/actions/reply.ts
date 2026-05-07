/**
 * Unified Instagram reply action: comment on post or DM user.
 */

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
import { logger } from "@elizaos/core";
import { INSTAGRAM_SERVICE_NAME } from "../constants";
import type { InstagramService } from "../service";

const REPLY_MODES = ["comment", "dm"] as const;
type InstagramReplyMode = (typeof REPLY_MODES)[number];

const MAX_INSTAGRAM_REPLY_TEXT_CHARS = 1_000;
const INSTAGRAM_ACTION_TIMEOUT_MS = 30_000;

function truncateActionText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function readParam(
  options: HandlerOptions | Record<string, unknown> | undefined,
  key: string
): unknown {
  const maybeOptions = options as { parameters?: Record<string, unknown> };
  if (maybeOptions?.parameters && key in maybeOptions.parameters) {
    return maybeOptions.parameters[key];
  }
  return (options as Record<string, unknown> | undefined)?.[key];
}

function readStringParam(
  options: HandlerOptions | Record<string, unknown> | undefined,
  key: string
): string | null {
  const value = readParam(options, key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readModeParam(
  options: HandlerOptions | Record<string, unknown> | undefined
): InstagramReplyMode | null {
  const raw = readStringParam(options, "mode");
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  return (REPLY_MODES as readonly string[]).includes(normalized)
    ? (normalized as InstagramReplyMode)
    : null;
}

export const instagramReplyAction: Action = {
  name: "INSTAGRAM_REPLY",
  description:
    "Reply on Instagram. mode=comment posts a comment on a media post (target=mediaId, text=comment). mode=dm sends a direct message to a thread (target=threadId, text=message).",
  descriptionCompressed: "Reply on Instagram: comment on post or DM user.",
  contexts: ["social_posting", "messaging", "connectors"],
  contextGate: {
    anyOf: ["social_posting", "messaging", "connectors"],
  },
  roleGate: { minRole: "USER" },
  similes: [
    "POST_INSTAGRAM_COMMENT",
    "INSTAGRAM_COMMENT",
    "COMMENT_INSTAGRAM",
    "REPLY_INSTAGRAM",
    "SEND_INSTAGRAM_DM",
    "INSTAGRAM_DM",
    "INSTAGRAM_MESSAGE",
    "DM_INSTAGRAM",
    "DIRECT_MESSAGE_INSTAGRAM",
  ],
  parameters: [
    {
      name: "mode",
      description: "Reply mode: comment (post comment) or dm (direct message).",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "target",
      description:
        "Target identifier: mediaId for comment, threadId for dm. Falls back to message.content.mediaId/threadId.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "text",
      description: "Reply text. Falls back to state.response.text or message.content.text.",
      required: false,
      schema: { type: "string" },
    },
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Reply to this Instagram comment" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll reply on Instagram.",
          actions: ["INSTAGRAM_REPLY"],
        },
      },
    ],
  ] as ActionExample[][],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return message.content.source === "instagram";
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    const service = runtime.getService(INSTAGRAM_SERVICE_NAME) as InstagramService;
    if (!service?.getIsRunning()) {
      if (callback) {
        await callback({ text: "Instagram service is not running" });
      }
      return { success: false, error: "Service not available" };
    }

    const mode = readModeParam(options);
    if (!mode) {
      const text = "Provide mode: comment | dm.";
      if (callback) await callback({ text });
      return { success: false, error: "missing_or_invalid_mode" };
    }

    const content = message.content as Record<string, unknown>;
    const responseText = truncateActionText(
      readStringParam(options, "text") ??
        ((state?.response as Record<string, unknown> | undefined)?.text as string | undefined) ??
        (content.text as string | undefined) ??
        "",
      MAX_INSTAGRAM_REPLY_TEXT_CHARS
    );
    const timeoutMs = INSTAGRAM_ACTION_TIMEOUT_MS;

    if (!responseText) {
      if (callback) {
        await callback({ text: "No reply text provided" });
      }
      return { success: false, error: "Empty reply" };
    }

    const targetParam = readStringParam(options, "target");

    if (mode === "comment") {
      const mediaIdRaw =
        targetParam ??
        (typeof content.mediaId === "number"
          ? String(content.mediaId)
          : (content.mediaId as string | undefined));
      const mediaId = mediaIdRaw ? Number.parseInt(mediaIdRaw, 10) : Number.NaN;
      if (!Number.isFinite(mediaId)) {
        if (callback) {
          await callback({ text: "No mediaId provided for Instagram comment" });
        }
        return { success: false, error: "Missing mediaId" };
      }

      logger.info({ src: "plugin:instagram", mode, mediaId }, "Posting Instagram comment");
      const commentId = await service.postComment(mediaId, responseText);
      logger.info(
        { src: "plugin:instagram", mode, mediaId, commentId },
        "Instagram comment posted"
      );
      if (callback) {
        await callback({
          text: `Comment posted on Instagram media ${mediaId}`,
          actions: ["INSTAGRAM_REPLY"],
        });
      }
      return { success: true, data: { mode, mediaId, commentId, timeoutMs } };
    }

    const threadId = targetParam ?? (content.threadId as string | undefined);
    if (!threadId) {
      if (callback) {
        await callback({ text: "No threadId provided for Instagram DM" });
      }
      return { success: false, error: "Missing threadId" };
    }

    logger.info({ src: "plugin:instagram", mode, threadId }, "Sending Instagram DM");
    const messageId = await service.sendDirectMessage(threadId, responseText);
    logger.info({ src: "plugin:instagram", mode, threadId, messageId }, "Instagram DM sent");
    if (callback) {
      await callback({
        text: `Message sent to Instagram thread ${threadId}`,
        actions: ["INSTAGRAM_REPLY"],
      });
    }
    return { success: true, data: { mode, threadId, messageId, timeoutMs } };
  },
};
