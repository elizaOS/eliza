import {
  addHeader,
  ContentType,
  type IAgentRuntime,
  MESSAGE_SOURCE_SUB_AGENT,
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
export const attachmentsProvider: Provider = {
  name: "ATTACHMENTS",
  description: "Media attachments in the current conversation",
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
    // Renders the room's complete attachment set, the same completeness
    // contract as RECENT_MESSAGES. ATTACHMENTS is a core response-state
    // provider, so it runs on every planner turn regardless of context; the
    // contextGate only places it in the Stage-1 catalog. The one skip is
    // structural: a sub-agent result turn that carries no attachments is the
    // orchestrator relaying a task outcome, not a request about the room's
    // media, so it renders nothing.
    if (
      message.content.source === MESSAGE_SOURCE_SUB_AGENT &&
      (message.content.attachments ?? []).length === 0
    ) {
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
    const allAttachments = await listConversationAttachments(runtime, message);
    const visibleAttachments = allAttachments;
    const omittedCount = 0;
    const formattedAttachments = visibleAttachments
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
      // whenever an IMAGE_DESCRIPTION model is registered.
      attachment.text ||
      (
        attachment.contentType === ContentType.IMAGE &&
          typeof runtime.getModel(ModelType.IMAGE_DESCRIPTION) === "function"
      )
        ? "available via ATTACHMENT action=read"
        : "none"
    }
    `,
      )
      .join("\n");
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
