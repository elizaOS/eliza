import {
  addHeader,
  ContentType,
  type IAgentRuntime,
  MESSAGE_SOURCE_SUB_AGENT,
  type Media,
  type Memory,
  ModelType,
  type Provider,
  type ProviderResult,
  toWellFormedUnicode,
} from "@elizaos/core";
import { listConversationAttachments } from "../../working-memory/attachmentContext.ts";

/**
 * Render an attachment URL for the prompt without dumping raw bytes into
 * context. Inline `data:` URLs (e.g. a TTS audio clip stored as
 * `data:audio/wav;base64,…`) are replaced with a compact descriptor — the
 * agent still knows the media exists and can pull it via `ATTACHMENT
 * action=read`, but a multi-KB base64 blob never reaches the model. Remote
 * URLs are passed through completely.
 */
function formatAttachmentUrlForPrompt(url: string | undefined): string {
  if (!url) return "(none)";
  if (url.startsWith("data:")) {
    const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? "binary";
    return `[inline ${mime} data, ${url.length} chars]`;
  }
  return toWellFormedUnicode(url);
}

const MAX_RENDERED_ATTACHMENTS = 5;

const RASTER_IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

function isRasterImageMedia(attachment: Media): boolean {
  if (attachment.contentType === ContentType.IMAGE) return true;
  if (typeof attachment.contentType === "string") {
    return RASTER_IMAGE_CONTENT_TYPES.has(attachment.contentType.toLowerCase());
  }
  if (
    typeof attachment.source === "string" &&
    attachment.source.toLowerCase() === "image" &&
    typeof attachment.url === "string"
  ) {
    return /\.(?:png|jpe?g|webp|gif)(?:\?.*)?$/i.test(attachment.url);
  }
  return false;
}

export const attachmentsProvider: Provider = {
  name: "ATTACHMENTS",
  description: "Media attachments in the current message",
  dynamic: true,
  contexts: ["media", "messaging"],
  contextGate: { anyOf: ["media", "messaging"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<ProviderResult> => {
    const hasOwnAttachments = (message.content.attachments ?? []).length > 0;
    if (message.content.source === MESSAGE_SOURCE_SUB_AGENT) {
      if (!hasOwnAttachments) {
        return {
          values: { attachments: "" },
          data: {
            attachments: [],
            visibleAttachments: [],
            omittedCount: 0,
          },
          text: "",
        };
      }
      // Sub-agents render their own message-borne attachments without paying for room history scan
      const ownAttachments = (message.content.attachments ?? []).slice(
        0,
        MAX_RENDERED_ATTACHMENTS,
      );
      const omittedCount = Math.max(
        0,
        (message.content.attachments ?? []).length - ownAttachments.length,
      );
      const formattedAttachments = ownAttachments
        .map(
          (attachment) => `ID: ${attachment.id}
    Name: ${attachment.title}
    URL: ${formatAttachmentUrlForPrompt(attachment.url)}
    Type: ${attachment.source}
    Content Type: ${attachment.contentType ?? "unknown"}
    Stored Content: ${
      attachment.text ||
      (
        isRasterImageMedia(attachment) &&
        typeof runtime.getModel(ModelType.IMAGE_DESCRIPTION) === "function"
      )
        ? "available via ATTACHMENT action=read"
        : "none"
    }
    `,
        )
        .join("\n");
      const text =
        formattedAttachments.length > 0
          ? addHeader("# Attachments", formattedAttachments)
          : "";
      return {
        values: { attachments: text },
        data: {
          attachments: message.content.attachments ?? [],
          visibleAttachments: ownAttachments,
          omittedCount,
        },
        text,
      };
    }

    const allAttachments = await listConversationAttachments(runtime, message);
    const visibleAttachments = allAttachments.slice(
      0,
      MAX_RENDERED_ATTACHMENTS,
    );
    const omittedCount = Math.max(
      0,
      allAttachments.length - visibleAttachments.length,
    );
    const shouldRenderText = visibleAttachments.length > 0;
    // Format attachments for display
    const formattedAttachments = shouldRenderText
      ? visibleAttachments
          .map(
            (attachment) => `ID: ${attachment.id}
    Name: ${attachment.title}
    URL: ${formatAttachmentUrlForPrompt(attachment.url)}
    Type: ${attachment.source}
    Content Type: ${attachment.contentType ?? "unknown"}
    Stored Content: ${
      // Keyed on text (the canonical readable-content field) only: failed
      // processing leaves text empty but stores failure prose in description,
      // which must not advertise an unsatisfiable ATTACHMENT read. Images are
      // the exception: the read action re-describes them at read time
      // (working-memory/attachmentContext), so the read is satisfiable
      // whenever an IMAGE_DESCRIPTION model is registered (#37027).
      attachment.text ||
      (
        isRasterImageMedia(attachment) &&
        typeof runtime.getModel(ModelType.IMAGE_DESCRIPTION) === "function"
      )
        ? "available via ATTACHMENT action=read"
        : "none"
    }
    `,
          )
          .join("\n")
      : "";
    // Create formatted text with header
    const text =
      formattedAttachments && formattedAttachments.length > 0
        ? addHeader("# Attachments", formattedAttachments)
        : "";
    const values = {
      attachments: text,
    };
    const data = {
      attachments: allAttachments,
      visibleAttachments,
      omittedCount,
    };
    return {
      values,
      data,
      text,
    };
  },
};
