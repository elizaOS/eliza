/**
 * Per-account inbound and outbound message handling for a Telegram bot: ingests
 * text, media, and document attachments from Telegraf update contexts, routes
 * them through the runtime, and dispatches agent replies back to Telegram.
 *
 * Inbound media is transcribed/described and normalized to core `Media`;
 * outbound replies are converted to MarkdownV2 (`utils.ts`), split at Telegram's
 * 4096-char limit, rendered with inline keyboards (`interactions.ts`), and
 * role-gated for embedded-app launch buttons. Owned by `TelegramService`, which
 * registers this as the connector's send path.
 */
import fs from "node:fs";
import {
  buildInteractionUrlResolver,
  ChannelType,
  type Content,
  type ContentType,
  createUniqueUuid,
  decodeCallback,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  lifeOpsPassiveConnectorsEnabled,
  logger,
  type Media,
  type Memory,
  type MessagePayload,
  ModelType,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import type {
  Chat,
  Document,
  InlineKeyboardButton,
  Message,
  ReactionType,
  Update,
} from "@telegraf/types";
import type { Context, NarrowedContext, Telegraf } from "telegraf";
import { Markup } from "telegraf";
import { resolveTelegramSenderAuth } from "./command-registration";
import { renderTelegramInteractions } from "./interactions";
import {
  type TelegramContent,
  TelegramEventTypes,
  type TelegramMessageSentPayload,
  type TelegramReactionReceivedPayload,
} from "./types";
import {
  cleanText,
  convertMarkdownToTelegram,
  convertToTelegramButtons,
} from "./utils";

/**
 * Interface for structured document processing results.
 */
interface DocumentProcessingResult {
  title: string;
  fullText: string;
  formattedDescription: string;
  fileName: string;
  mimeType: string | undefined;
  fileSize: number | undefined;
  error?: string;
}

/**
 * Enum representing different types of media.
 * @enum { string }
 * @readonly
 */
export enum MediaType {
  PHOTO = "photo",
  VIDEO = "video",
  DOCUMENT = "document",
  AUDIO = "audio",
  ANIMATION = "animation",
}

/**
 * Map a Telegram file's MIME type to the coarse core ContentType. Returns the
 * literal string values (not the `ContentType` enum object) so this stays a
 * pure, dependency-free mapping — `ContentType` is imported as a type only.
 */
function contentTypeForMime(mime?: string): ContentType {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  return "document";
}

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length
const INTERACTION_ONLY_FALLBACK_TEXT = "Choose an option:";
const ACTION_PROGRESS_SOURCE = "action_progress";
const COMPUTER_USE_APPROVAL_CALLBACK_RE =
  /^cua:([^:]+):(approve|deny)(?::u([^:]+))?$/;

type PdfTextService = {
  convertPdfToText(pdfBuffer: Buffer): Promise<string>;
};

type TelegramMessageEditor = (
  chatId: number | string,
  messageId: number,
  text: string,
  messageThreadId?: number,
) => Promise<void>;

type CompactProgressCallbackOptions = {
  baseCallback: HandlerCallback;
  editMessage: TelegramMessageEditor;
  chatId: number | string;
  threadId?: number;
};

type ComputerUseApprovalCallback = {
  approvalId: string;
  approved: boolean;
  ownerId?: string;
};

type ComputerUseApprovalResolver = {
  resolveApproval(
    id: string,
    approved: boolean,
    reason?: string,
  ): unknown | Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function telegramIdentityMetadata(
  telegramUserId: string,
  name?: string,
  username?: string,
): Record<string, string> {
  return {
    userId: telegramUserId,
    id: telegramUserId,
    ...(name ? { name } : {}),
    ...(username ? { username } : {}),
  };
}

function isCompactProgressContent(
  content: Content,
): content is Content & { text: string } {
  if (!content.text || content.source !== ACTION_PROGRESS_SOURCE) {
    return false;
  }
  const metadata = isRecord(content.metadata) ? content.metadata : {};
  return metadata.compactProgress === true;
}

function telegramMessageIdFromMemory(memory: Memory): number | null {
  const metadata = isRecord(memory.metadata) ? memory.metadata : {};
  const telegram = isRecord(metadata.telegram) ? metadata.telegram : undefined;
  const rawMessageId =
    telegram?.messageId ??
    metadata.messageIdFull ??
    metadata.messageId ??
    undefined;
  const numeric =
    typeof rawMessageId === "string" || typeof rawMessageId === "number"
      ? Number(rawMessageId)
      : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function isComputerUseApprovalResolver(
  service: unknown,
): service is ComputerUseApprovalResolver {
  return isRecord(service) && typeof service.resolveApproval === "function";
}

export function parseComputerUseApprovalCallback(
  value: string,
): ComputerUseApprovalCallback | null {
  const match = value.match(COMPUTER_USE_APPROVAL_CALLBACK_RE);
  if (!match) return null;
  const parsed: ComputerUseApprovalCallback = {
    approvalId: match[1],
    approved: match[2] === "approve",
  };
  if (match[3]) {
    parsed.ownerId = match[3];
  }
  return parsed;
}

export function createTelegramCompactProgressCallback({
  baseCallback,
  editMessage,
  chatId,
  threadId,
}: CompactProgressCallbackOptions): HandlerCallback {
  let statusMessageId: number | null = null;

  return async (content, actionName) => {
    if (!isCompactProgressContent(content)) {
      return baseCallback(content, actionName);
    }

    const text = content.text;
    if (statusMessageId !== null) {
      try {
        await editMessage(chatId, statusMessageId, text, threadId);
        return [];
      } catch (error) {
        logger.warn(
          {
            src: "plugin:telegram",
            chatId,
            messageId: statusMessageId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to edit compact progress message; sending a new update",
        );
      }
    }

    const memories = await baseCallback(content, actionName);
    for (const memory of memories) {
      const messageId = telegramMessageIdFromMemory(memory);
      if (messageId !== null) {
        statusMessageId = messageId;
        break;
      }
    }
    return memories;
  };
}

function isPdfTextService(service: unknown): service is PdfTextService {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as { convertPdfToText?: unknown }).convertPdfToText ===
      "function"
  );
}

type TelegramMediaSender = (
  chatId: number | string,
  media: string | { source: fs.ReadStream },
  extra?: { caption?: string },
) => Promise<unknown>;

const getChannelType = (chat: Chat): ChannelType => {
  const chatType = chat.type;

  // Use a switch statement for clarity and exhaustive checks
  switch (chatType) {
    case "private":
      return ChannelType.DM;
    case "group":
    case "supergroup":
    case "channel":
      return ChannelType.GROUP;
    default:
      throw new Error(`Unrecognized Telegram chat type: ${String(chatType)}`);
  }
};

/** Label on the embedded-app (Telegram Mini App) launch button. */
const EMBED_LAUNCH_BUTTON_TEXT = "Open Eliza App";

/**
 * Resolve the embedded-app `/embed` launch URL for the role-gated Mini App
 * button (#9947). Reads the explicit `ELIZA_EMBED_URL` if set, otherwise
 * derives `<web base>/embed` from `ELIZA_APP_URL` / `ELIZA_CLOUD_URL`. Returns
 * `undefined` when nothing is configured or the resolved URL is not absolute
 * `https` — Telegram rejects `web_app` buttons that are not https, so the
 * button is simply not emitted rather than sent with an invalid URL.
 */
function resolveEmbedLaunchUrl(runtime: IAgentRuntime): string | undefined {
  const direct = runtime.getSetting("ELIZA_EMBED_URL");
  if (typeof direct === "string" && direct.trim().length > 0) {
    return toHttpsUrl(direct.trim(), "telegram");
  }
  const base =
    runtime.getSetting("ELIZA_APP_URL") ||
    runtime.getSetting("ELIZA_CLOUD_URL");
  if (typeof base === "string" && base.trim().length > 0) {
    return toHttpsUrl(`${base.trim().replace(/\/+$/, "")}/embed`, "telegram");
  }
  return undefined;
}

/** Return the URL only when it parses as absolute `https`, else `undefined`. */
function toHttpsUrl(url: string, platform: "telegram"): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.pathname === "/" || parsed.pathname === "") {
    parsed.pathname = "/embed";
  }
  parsed.searchParams.set("platform", platform);
  return parsed.toString();
}

/** Build the Telegram `web_app` inline-keyboard button for the `/embed` route. */
function buildEmbedLaunchButton(url: string): InlineKeyboardButton {
  return { text: EMBED_LAUNCH_BUTTON_TEXT, web_app: { url } };
}

/**
 * Class representing a message manager.
 * @class
 */
export class MessageManager {
  public bot: Telegraf<Context>;
  protected runtime: IAgentRuntime;
  protected accountId: string;

  /**
   * Constructor for creating a new instance of a BotAgent.
   *
   * @param {Telegraf<Context>} bot - The Telegraf instance used for interacting with the bot platform.
   * @param {IAgentRuntime} runtime - The runtime environment for the agent.
   */
  constructor(
    bot: Telegraf<Context>,
    runtime: IAgentRuntime,
    accountId = "default",
  ) {
    this.bot = bot;
    this.runtime = runtime;
    this.accountId = accountId;
  }

  private scopedTelegramKey(key: string): string {
    return this.accountId === "default" ? key : `${this.accountId}:${key}`;
  }

  /**
   * Build the embedded-app (Mini App) launch keyboard row for the current
   * sender (#9947). Returns a single `web_app` button only when (a) an https
   * `/embed` URL is configured and (b) `resolveTelegramSenderAuth` resolves the
   * sender to an elevated role (OWNER or ADMIN). A non-elevated sender — or an
   * unconfigured / non-https embed URL — yields `[]`, so no launch button is
   * ever surfaced to an unauthorized user. The result is wired into the
   * existing `keyboardRows` path; it is not a parallel keyboard mechanism.
   */
  protected async buildEmbedLaunchRow(
    ctx: Context,
  ): Promise<InlineKeyboardButton[]> {
    const url = resolveEmbedLaunchUrl(this.runtime);
    if (!url) return [];
    const sender = await resolveTelegramSenderAuth(
      ctx,
      this.runtime,
      this.accountId,
    );
    if (!sender.isAuthorized && !sender.isElevated) return [];
    return [buildEmbedLaunchButton(url)];
  }

  /**
   * Process an image from a Telegram message to extract the image URL and description.
   *
   * @param {Message} message - The Telegram message object containing the image.
   * @returns {Promise<{ description: string } | null>} The description of the processed image or null if no image found.
   */
  async processImage(
    message: Message,
  ): Promise<{ description: string } | null> {
    try {
      let imageUrl: string | null = null;

      logger.debug(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          messageId: message.message_id,
        },
        "Processing image from message",
      );

      if ("photo" in message && message.photo.length > 0) {
        const photo = message.photo[message.photo.length - 1];
        const fileLink = await this.bot.telegram.getFileLink(photo.file_id);
        imageUrl = fileLink.toString();
      } else if (
        "document" in message &&
        message.document.mime_type?.startsWith("image/") &&
        !message.document.mime_type.startsWith("application/pdf")
      ) {
        const fileLink = await this.bot.telegram.getFileLink(
          message.document.file_id,
        );
        imageUrl = fileLink.toString();
      }

      if (imageUrl) {
        const { title, description } = await this.runtime.useModel(
          ModelType.IMAGE_DESCRIPTION,
          imageUrl,
        );
        return { description: `[Image: ${title}\n${description}]` };
      }
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error processing image",
      );
    }

    return null;
  }

  /**
   * Process a document from a Telegram message to extract the document URL and description.
   * Handles PDFs and other document types by converting them to text when possible.
   *
   * @param {Message} message - The Telegram message object containing the document.
   * @returns {Promise<{ description: string } | null>} The description of the processed document or null if no document found.
   */
  async processDocument(
    message: Message,
  ): Promise<DocumentProcessingResult | null> {
    try {
      if (!("document" in message) || !message.document) {
        return null;
      }

      const document = message.document;
      const fileLink = await this.bot.telegram.getFileLink(document.file_id);
      const documentUrl = fileLink.toString();

      logger.debug(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          fileName: document.file_name,
          mimeType: document.mime_type,
          fileSize: document.file_size,
        },
        "Processing document",
      );

      // Centralized document processing based on MIME type
      const documentProcessor = this.getDocumentProcessor(document.mime_type);
      if (documentProcessor) {
        return await documentProcessor(document, documentUrl);
      }

      // Generic fallback for unsupported types
      return {
        title: `Document: ${document.file_name || "Unknown Document"}`,
        fullText: "",
        formattedDescription: `[Document: ${document.file_name || "Unknown Document"}\nType: ${document.mime_type || "unknown"}\nSize: ${document.file_size || 0} bytes]`,
        fileName: document.file_name || "Unknown Document",
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error processing document",
      );
      return null;
    }
  }

  /**
   * Get the appropriate document processor based on MIME type.
   */
  private getDocumentProcessor(
    mimeType?: string,
  ):
    | ((document: Document, url: string) => Promise<DocumentProcessingResult>)
    | null {
    if (!mimeType) {
      return null;
    }

    const processors = {
      "application/pdf": this.processPdfDocument.bind(this),
      "text/": this.processTextDocument.bind(this), // covers text/plain, text/csv, text/markdown, etc.
      "application/json": this.processTextDocument.bind(this),
    };

    for (const [pattern, processor] of Object.entries(processors)) {
      if (mimeType.startsWith(pattern)) {
        return processor;
      }
    }

    return null;
  }

  /**
   * Process PDF documents by converting them to text.
   */
  private async processPdfDocument(
    document: Document,
    documentUrl: string,
  ): Promise<DocumentProcessingResult> {
    try {
      const pdfServiceCandidate = this.runtime.getService(ServiceType.PDF);
      const pdfService = isPdfTextService(pdfServiceCandidate)
        ? pdfServiceCandidate
        : null;
      if (!pdfService) {
        logger.warn(
          { src: "plugin:telegram", agentId: this.runtime.agentId },
          "PDF service not available, using fallback",
        );
        return {
          title: `PDF Document: ${document.file_name || "Unknown Document"}`,
          fullText: "",
          formattedDescription: `[PDF Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nUnable to extract text content]`,
          fileName: document.file_name || "Unknown Document",
          mimeType: document.mime_type,
          fileSize: document.file_size,
        };
      }

      const response = await fetch(documentUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch PDF: ${response.status}`);
      }

      const pdfBuffer = await response.arrayBuffer();
      const text = await pdfService.convertPdfToText(Buffer.from(pdfBuffer));

      logger.debug(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          fileName: document.file_name,
          charactersExtracted: text.length,
        },
        "PDF processed successfully",
      );
      return {
        title: document.file_name || "Unknown Document",
        fullText: text,
        formattedDescription: `[PDF Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nText extracted successfully: ${text.length} characters]`,
        fileName: document.file_name || "Unknown Document",
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          fileName: document.file_name,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error processing PDF document",
      );
      return {
        title: `PDF Document: ${document.file_name || "Unknown Document"}`,
        fullText: "",
        formattedDescription: `[PDF Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nError: Unable to extract text content]`,
        fileName: document.file_name || "Unknown Document",
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    }
  }

  /**
   * Process text documents by fetching their content.
   */
  private async processTextDocument(
    document: Document,
    documentUrl: string,
  ): Promise<DocumentProcessingResult> {
    try {
      const response = await fetch(documentUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch text document: ${response.status}`);
      }

      const text = await response.text();

      logger.debug(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          fileName: document.file_name,
          charactersExtracted: text.length,
        },
        "Text document processed successfully",
      );
      return {
        title: document.file_name || "Unknown Document",
        fullText: text,
        formattedDescription: `[Text Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nText extracted successfully: ${text.length} characters]`,
        fileName: document.file_name || "Unknown Document",
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          fileName: document.file_name,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error processing text document",
      );
      return {
        title: `Text Document: ${document.file_name || "Unknown Document"}`,
        fullText: "",
        formattedDescription: `[Text Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nError: Unable to read content]`,
        fileName: document.file_name || "Unknown Document",
        mimeType: document.mime_type,
        fileSize: document.file_size,
      };
    }
  }

  /**
   * Processes the message content, documents, and images to generate
   * processed content and media attachments.
   *
   * @param {Message} message The message to process
   * @returns {Promise<{ processedContent: string; attachments: Media[] }>} Processed content and media attachments
   */
  async processMessage(
    message: Message,
  ): Promise<{ processedContent: string; attachments: Media[] }> {
    let processedContent = "";
    const attachments: Media[] = [];

    // Get message text
    if ("text" in message && message.text) {
      processedContent = message.text;
    } else if ("caption" in message && message.caption) {
      processedContent = message.caption as string;
    }

    // Process documents
    if ("document" in message && message.document) {
      const document = message.document;
      const documentInfo = await this.processDocument(message);

      if (documentInfo) {
        try {
          const fileLink = await this.bot.telegram.getFileLink(
            document.file_id,
          );

          // Use structured data directly instead of regex parsing
          const title = documentInfo.title;
          const fullText = documentInfo.fullText;

          // Add document content to processedContent so agent can access it
          if (fullText) {
            const documentContent = `\n\n--- DOCUMENT CONTENT ---\nTitle: ${title}\n\nFull Content:\n${fullText}\n--- END DOCUMENT ---\n\n`;
            processedContent += documentContent;
          }

          attachments.push({
            id: document.file_id,
            url: fileLink.toString(),
            title,
            source: document.mime_type?.startsWith("application/pdf")
              ? "PDF"
              : "Document",
            contentType: contentTypeForMime(document.mime_type),
            description: documentInfo.formattedDescription,
            text: fullText,
          });
          logger.debug(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              fileName: documentInfo.fileName,
            },
            "Document processed successfully",
          );
        } catch (error) {
          logger.error(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              fileName: documentInfo.fileName,
              error: error instanceof Error ? error.message : String(error),
            },
            "Error processing document",
          );
          // Add a fallback attachment even if processing failed
          attachments.push({
            id: document.file_id,
            url: "",
            title: `Document: ${documentInfo.fileName}`,
            source: "Document",
            description: `Document processing failed: ${documentInfo.fileName}`,
            text: `Document: ${documentInfo.fileName}\nSize: ${documentInfo.fileSize || 0} bytes\nType: ${documentInfo.mimeType || "unknown"}`,
          });
        }
      } else {
        // Add a basic attachment even if documentInfo is null
        attachments.push({
          id: document.file_id,
          url: "",
          title: `Document: ${document.file_name || "Unknown Document"}`,
          source: "Document",
          description: `Document: ${document.file_name || "Unknown Document"}`,
          text: `Document: ${document.file_name || "Unknown Document"}\nSize: ${document.file_size || 0} bytes\nType: ${document.mime_type || "unknown"}`,
        });
      }
    }

    // Process images
    if ("photo" in message && message.photo.length > 0) {
      const imageInfo = await this.processImage(message);
      if (imageInfo) {
        try {
          const photo = message.photo[message.photo.length - 1];
          const fileLink = await this.bot.telegram.getFileLink(photo.file_id);
          attachments.push({
            id: photo.file_id,
            url: fileLink.toString(),
            title: "Image Attachment",
            source: "Image",
            contentType: "image",
            description: imageInfo.description,
            text: imageInfo.description,
          });
        } catch (error) {
          logger.error(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Error attaching processed image",
          );
        }
      }
    }

    // Voice / audio / video / animation / sticker attachments. Setting
    // contentType lets processAttachments transcribe audio/video and lets the
    // attachment round-trip safely back out to any connector.
    const pushFileAttachment = async (
      fileId: string,
      contentType: ContentType,
      title: string,
      source: string,
    ): Promise<void> => {
      try {
        const fileLink = await this.bot.telegram.getFileLink(fileId);
        attachments.push({
          id: fileId,
          url: fileLink.toString(),
          title,
          source,
          contentType,
        });
      } catch (error) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          `Error attaching ${source}`,
        );
      }
    };

    if ("voice" in message && message.voice) {
      await pushFileAttachment(
        message.voice.file_id,
        "audio",
        "Voice Message",
        "Voice",
      );
    }
    if ("audio" in message && message.audio) {
      await pushFileAttachment(
        message.audio.file_id,
        "audio",
        message.audio.title || message.audio.file_name || "Audio",
        "Audio",
      );
    }
    if ("video" in message && message.video) {
      await pushFileAttachment(
        message.video.file_id,
        "video",
        "Video",
        "Video",
      );
    }
    if ("video_note" in message && message.video_note) {
      await pushFileAttachment(
        message.video_note.file_id,
        "video",
        "Video Note",
        "Video",
      );
    }
    if ("animation" in message && message.animation) {
      await pushFileAttachment(
        message.animation.file_id,
        "video",
        "Animation",
        "Animation",
      );
    }
    if ("sticker" in message && message.sticker) {
      await pushFileAttachment(
        message.sticker.file_id,
        "image",
        "Sticker",
        "Sticker",
      );
    }

    logger.debug(
      {
        src: "plugin:telegram",
        agentId: this.runtime.agentId,
        hasContent: !!processedContent,
        attachmentsCount: attachments.length,
      },
      "Message processed",
    );

    return { processedContent, attachments };
  }

  /**
   * Issue a Telegram send with bounded resilience so a transient error doesn't
   * silently drop the agent's reply. On a 429 it honors the server-supplied
   * `retry_after` (capped) and retries; on a MarkdownV2 400 (parse/length) it
   * retries once via `plainTextFallback` so the user gets unformatted content
   * instead of nothing. Other errors (e.g. 403 blocked) propagate unchanged.
   * The inbound polling path is already resilient in telegraf; this covers the
   * outbound path it does not.
   */
  private async sendWithRetry<T>(
    send: () => Promise<T>,
    plainTextFallback?: () => Promise<T>,
  ): Promise<T> {
    const MAX_RATE_LIMIT_RETRIES = 2;
    const MAX_RETRY_AFTER_SECONDS = 30;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        const response = (
          error as {
            response?: {
              error_code?: number;
              description?: string;
              parameters?: { retry_after?: number };
            };
          }
        ).response;
        const code = response?.error_code;
        if (code === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
          const retryAfter = Math.min(
            response?.parameters?.retry_after ?? 1,
            MAX_RETRY_AFTER_SECONDS,
          );
          logger.warn(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              retryAfter,
            },
            "Telegram rate-limited (429); retrying after retry_after",
          );
          await new Promise((resolve) =>
            setTimeout(resolve, retryAfter * 1000),
          );
          continue;
        }
        if (
          code === 400 &&
          plainTextFallback &&
          /parse|entit|too long/i.test(response?.description ?? "")
        ) {
          logger.warn(
            { src: "plugin:telegram", agentId: this.runtime.agentId },
            "Telegram rejected formatted message (400); retrying as plain text",
          );
          return await plainTextFallback();
        }
        throw error;
      }
    }
  }

  /**
   * Sends a message in chunks, handling attachments and splitting the message if necessary
   *
   * @param {Context} ctx - The context object representing the current state of the bot
   * @param {TelegramContent} content - The content of the message to be sent
   * @param {number} [replyToMessageId] - The ID of the message to reply to, if any
   * @returns {Promise<Message.TextMessage[]>} - An array of TextMessage objects representing the messages sent
   */
  async sendMessageInChunks(
    ctx: Context,
    content: TelegramContent,
    replyToMessageId?: number,
    messageThreadId?: number,
  ): Promise<Message.TextMessage[]> {
    if (content.attachments && content.attachments.length > 0) {
      await Promise.all(
        content.attachments.map(async (attachment: Media) => {
          const typeMap: { [key: string]: MediaType } = {
            "image/gif": MediaType.ANIMATION,
            image: MediaType.PHOTO,
            doc: MediaType.DOCUMENT,
            video: MediaType.VIDEO,
            audio: MediaType.AUDIO,
          };

          let mediaType: MediaType | undefined;

          for (const prefix in typeMap) {
            if (attachment.contentType?.startsWith(prefix)) {
              mediaType = typeMap[prefix];
              break;
            }
          }

          if (!mediaType) {
            // Degrade unknown/absent content types to a document upload instead
            // of throwing — a throw inside Promise.all aborts the whole reply
            // and silently drops the agent's text.
            logger.warn(
              {
                src: "plugin:telegram",
                agentId: this.runtime.agentId,
                contentType: attachment.contentType,
              },
              "Unknown Telegram attachment content type; sending as document",
            );
            mediaType = MediaType.DOCUMENT;
          }

          await this.sendMedia(
            ctx,
            attachment.url,
            mediaType,
            attachment.description,
          );
        }),
      );
      // Fall through to the text path below so an attachment reply never drops
      // the agent's accompanying prose (sent as a follow-up message).
    }

    {
      // Project any interactive blocks (choices, task cards, …) the agent
      // embedded in the text onto native inline keyboards, and send the prose
      // with the markers stripped. Plain replies pass through unchanged.
      const rawAppUrl =
        this.runtime.getSetting("ELIZA_APP_URL") ||
        this.runtime.getSetting("ELIZA_CLOUD_URL");
      const appBaseUrl = typeof rawAppUrl === "string" ? rawAppUrl : undefined;
      const rendered = renderTelegramInteractions(
        content,
        buildInteractionUrlResolver(appBaseUrl),
      );
      const sentMessages: Message.TextMessage[] = [];

      const telegramButtons = convertToTelegramButtons(content.buttons ?? []);
      const hasKeyboardRows =
        rendered.keyboardRows.length > 0 || telegramButtons.length > 0;
      const textToSend =
        rendered.text.trim().length > 0
          ? rendered.text
          : hasKeyboardRows
            ? INTERACTION_ONLY_FALLBACK_TEXT
            : "";
      // Nothing textual to send (e.g. an attachments-only reply that already
      // dispatched its media above) — don't post an empty trailing message.
      if (textToSend.trim().length === 0 && !hasKeyboardRows) {
        return sentMessages;
      }

      const chunks = this.splitMessage(textToSend);

      if (!ctx.chat) {
        logger.error(
          { src: "plugin:telegram", agentId: this.runtime.agentId },
          "sendMessageInChunks: ctx.chat is undefined",
        );
        return [];
      }
      // The typing indicator is cosmetic and best-effort — a failure here must
      // never abort the actual reply on the critical path below.
      try {
        await ctx.telegram.sendChatAction(ctx.chat.id, "typing");
      } catch (error) {
        logger.debug(
          {
            src: "plugin:telegram",
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "sendChatAction (typing) failed; continuing",
        );
      }

      // Role-gated embedded-app launch row: resolved once (it performs a role
      // lookup) and attached to the final chunk only, alongside any other
      // interaction controls.
      const embedLaunchRow = await this.buildEmbedLaunchRow(ctx);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = convertMarkdownToTelegram(chunks[i]);
        if (!ctx.chat) {
          logger.error(
            { src: "plugin:telegram", agentId: this.runtime.agentId },
            "sendMessageInChunks loop: ctx.chat is undefined",
          );
          continue;
        }
        // Interaction controls go on the final chunk only; explicit
        // `content.buttons` keep their existing per-chunk behavior.
        const isLast = i === chunks.length - 1;
        const keyboardRows: InlineKeyboardButton[][] = [];
        if (isLast && rendered.keyboardRows.length > 0) {
          keyboardRows.push(...rendered.keyboardRows);
        }
        if (telegramButtons.length > 0) keyboardRows.push(telegramButtons);
        if (isLast && embedLaunchRow.length > 0) {
          keyboardRows.push(embedLaunchRow);
        }
        const replyMarkup =
          keyboardRows.length > 0
            ? Markup.inlineKeyboard(keyboardRows).reply_markup
            : undefined;

        const chatId = ctx.chat.id;
        const sendOptions = {
          reply_parameters:
            i === 0 && replyToMessageId
              ? { message_id: replyToMessageId }
              : undefined,
          message_thread_id: messageThreadId,
          reply_markup: replyMarkup,
        };
        const sentMessage = (await this.sendWithRetry(
          () =>
            ctx.telegram.sendMessage(chatId, chunk, {
              ...sendOptions,
              parse_mode: "MarkdownV2",
            }),
          // Fallback: Telegram rejected the MarkdownV2 entities. Send the
          // ORIGINAL chunk (chunks[i]), not the MarkdownV2-escaped `chunk` —
          // otherwise the user sees literal backslash escapes ("Sure\!"). Mirror
          // the editMessage fallback, which sends cleanText(text).
          () =>
            ctx.telegram.sendMessage(chatId, cleanText(chunks[i]), sendOptions),
        )) as Message.TextMessage;

        sentMessages.push(sentMessage);
      }

      return sentMessages;
    }
  }

  private async persistSentMessageMemories(args: {
    sentMessages: Message.TextMessage[];
    content: TelegramContent;
    roomId: UUID;
    channelType: ChannelType;
    chatType: string;
    threadId?: string;
    inReplyTo: UUID;
  }): Promise<Memory[]> {
    const memories: Memory[] = [];
    for (const sentMessage of args.sentMessages) {
      const responseMemory: Memory = {
        id: createUniqueUuid(
          this.runtime,
          this.scopedTelegramKey(sentMessage.message_id.toString()),
        ),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId: args.roomId,
        content: {
          ...args.content,
          source: "telegram",
          text: sentMessage.text,
          inReplyTo: args.inReplyTo,
          channelType: args.channelType,
          metadata: { accountId: this.accountId },
        },
        metadata: {
          type: "message",
          source: "telegram",
          accountId: this.accountId,
          provider: "telegram",
          timestamp: sentMessage.date * 1000,
          fromBot: true,
          fromId: this.runtime.agentId,
          sourceId: this.runtime.agentId,
          chatType: args.chatType,
          messageIdFull: sentMessage.message_id.toString(),
          telegram: {
            chatId: sentMessage.chat.id,
            messageId: sentMessage.message_id.toString(),
            threadId: args.threadId,
          },
        } satisfies Memory["metadata"],
        createdAt: sentMessage.date * 1000,
      };

      await this.runtime.createMemory(responseMemory, "messages");
      memories.push(responseMemory);
    }

    return memories;
  }

  /**
   * Sends media to a chat using the Telegram API.
   *
   * @param {Context} ctx - The context object containing information about the current chat.
   * @param {string} mediaPath - The path to the media to be sent, either a URL or a local file path.
   * @param {MediaType} type - The type of media being sent (PHOTO, VIDEO, DOCUMENT, AUDIO, or ANIMATION).
   * @param {string} [caption] - Optional caption for the media being sent.
   *
   * @returns {Promise<void>} A Promise that resolves when the media is successfully sent.
   */
  async sendMedia(
    ctx: Context,
    mediaPath: string,
    type: MediaType,
    caption?: string,
  ): Promise<void> {
    try {
      const isUrl = /^(http|https):\/\//.test(mediaPath);
      // Look up the raw sender lazily and bind only the one we need. Building
      // the full map up front and `.bind`-ing every entry would crash with
      // "Cannot read properties of undefined" if the Telegram client is missing
      // any single sender, aborting an unrelated media send.
      const rawSenders: Record<MediaType, TelegramMediaSender | undefined> = {
        [MediaType.PHOTO]: ctx.telegram.sendPhoto,
        [MediaType.VIDEO]: ctx.telegram.sendVideo,
        [MediaType.DOCUMENT]: ctx.telegram.sendDocument,
        [MediaType.AUDIO]: ctx.telegram.sendAudio,
        [MediaType.ANIMATION]: ctx.telegram.sendAnimation,
      };

      const rawSend = rawSenders[type];
      if (typeof rawSend !== "function") {
        throw new Error(`Unsupported media type: ${type}`);
      }
      const sendFunction = rawSend.bind(ctx.telegram);

      if (!ctx.chat) {
        throw new Error("sendMedia: ctx.chat is undefined");
      }

      if (isUrl) {
        // Handle HTTP URLs
        await sendFunction(ctx.chat.id, mediaPath, { caption });
      } else {
        // Handle local file paths
        if (!fs.existsSync(mediaPath)) {
          throw new Error(`File not found at path: ${mediaPath}`);
        }

        const fileStream = fs.createReadStream(mediaPath);

        try {
          if (!ctx.chat) {
            throw new Error("sendMedia (file): ctx.chat is undefined");
          }
          await sendFunction(ctx.chat.id, { source: fileStream }, { caption });
        } finally {
          fileStream.destroy();
        }
      }

      logger.debug(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          mediaType: type,
          mediaPath,
        },
        "Media sent successfully",
      );
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          mediaType: type,
          mediaPath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to send media",
      );
      throw error;
    }
  }

  /**
   * Splits a given text into an array of strings based on the maximum message length.
   *
   * @param {string} text - The text to split into chunks.
   * @returns {string[]} An array of strings with each element representing a chunk of the original text.
   */
  private splitMessage(text: string): string[] {
    const chunks: string[] = [];
    if (!text) {
      return chunks;
    }

    let currentChunk = "";

    const appendSegment = (segment: string) => {
      let remaining = segment;

      while (remaining.length > 0) {
        const availableLength = MAX_MESSAGE_LENGTH - currentChunk.length;

        if (remaining.length <= availableLength) {
          currentChunk += remaining;
          return;
        }

        if (availableLength > 0) {
          currentChunk += remaining.slice(0, availableLength);
          remaining = remaining.slice(availableLength);
        }

        if (currentChunk) {
          chunks.push(currentChunk);
          currentChunk = "";
        }
      }
    };

    const lines = text.split("\n");
    for (const line of lines) {
      let segment = currentChunk ? `\n${line}` : line;
      if (!segment) {
        continue;
      }

      if (
        currentChunk &&
        currentChunk.length + segment.length > MAX_MESSAGE_LENGTH
      ) {
        chunks.push(currentChunk);
        currentChunk = "";
        segment = line;
        if (!segment) {
          continue;
        }
      }

      appendSegment(segment);
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }
    return chunks;
  }

  /**
   * Handle incoming messages from Telegram and process them accordingly.
   * @param {Context} ctx - The context object containing information about the message.
   * @param {object} [options] - Handling options.
   * @param {boolean} [options.forceReply] - When true, always route the message
   *   through the agent and force a reply, bypassing the TELEGRAM_AUTO_REPLY gate.
   *   Used for explicit slash-command invocations where the user intent to get a
   *   response is unambiguous.
   * @returns {Promise<void>}
   */
  public async handleMessage(
    ctx: Context,
    options?: { forceReply?: boolean },
  ): Promise<void> {
    if (!ctx.message || !ctx.from) {
      return;
    }

    const message = ctx.message as Message.TextMessage;

    try {
      const telegramUserId = ctx.from.id.toString();
      const entityId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(telegramUserId),
      ) as UUID;

      const threadId =
        "is_topic_message" in message && message.is_topic_message
          ? message.message_thread_id?.toString()
          : undefined;

      if (!ctx.chat) {
        logger.error(
          { src: "plugin:telegram", agentId: this.runtime.agentId },
          "handleMessage: ctx.chat is undefined",
        );
        return;
      }
      const telegramRoomid = threadId
        ? `${ctx.chat.id}-${threadId}`
        : ctx.chat.id.toString();
      const telegramChatId = ctx.chat.id.toString();
      const scopedRoomKey = this.scopedTelegramKey(telegramRoomid);
      const scopedChatKey = this.scopedTelegramKey(telegramChatId);
      const roomId = createUniqueUuid(this.runtime, scopedRoomKey) as UUID;
      const worldId = createUniqueUuid(this.runtime, scopedChatKey) as UUID;
      const telegramMessageId = message.message_id.toString();
      const messageId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(telegramMessageId),
      );

      // Process message content and attachments
      const { processedContent, attachments } =
        await this.processMessage(message);

      // Clean processedContent and attachments to avoid NULL characters
      const cleanedContent = cleanText(processedContent);
      const cleanedAttachments = attachments.map((att) => ({
        ...att,
        text: cleanText(att.text),
        description: cleanText(att.description),
        title: cleanText(att.title),
      }));

      if (!cleanedContent && cleanedAttachments.length === 0) {
        return;
      }

      // Get chat type and determine channel type
      const chat = message.chat as Chat;
      const channelType = getChannelType(chat);

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        roomName:
          ("title" in chat && typeof chat.title === "string" && chat.title) ||
          ("first_name" in chat &&
            typeof chat.first_name === "string" &&
            chat.first_name) ||
          ("username" in chat &&
            typeof chat.username === "string" &&
            chat.username) ||
          telegramRoomid,
        userName: ctx.from.username,
        name: ctx.from.first_name,
        userId: telegramUserId as UUID,
        source: "telegram",
        channelId: telegramRoomid,
        type: channelType,
        worldId,
        worldName: telegramRoomid,
      });

      // Create the memory object
      const memory: Memory = {
        id: messageId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          text: cleanedContent || " ",
          attachments: cleanedAttachments,
          source: "telegram",
          metadata: { accountId: this.accountId },
          channelType,
          inReplyTo:
            "reply_to_message" in message && message.reply_to_message
              ? createUniqueUuid(
                  this.runtime,
                  this.scopedTelegramKey(
                    message.reply_to_message.message_id.toString(),
                  ),
                )
              : undefined,
        },
        metadata: {
          type: "message",
          source: "telegram",
          accountId: this.accountId,
          provider: "telegram",
          timestamp: message.date * 1000,
          entityName: ctx.from.first_name,
          entityUserName: ctx.from.username,
          fromBot: ctx.from.is_bot,
          fromId: telegramUserId,
          sourceId: entityId,
          chatType: chat.type,
          messageIdFull: telegramMessageId,
          sender: {
            id: telegramUserId,
            name: ctx.from.first_name,
            username: ctx.from.username,
          },
          telegram: {
            ...telegramIdentityMetadata(
              telegramUserId,
              ctx.from.first_name,
              ctx.from.username,
            ),
            chatId: telegramChatId,
            messageId: telegramMessageId,
            threadId,
          },
          telegramUserId,
          telegramChatId,
        } satisfies Memory["metadata"],
        createdAt: message.date * 1000,
      };

      const threadIdNum =
        threadId && Number.isFinite(Number(threadId))
          ? Number(threadId)
          : undefined;

      // Create callback for handling responses
      const baseCallback: HandlerCallback = async (
        content: Content,
        _actionName?: string,
      ) => {
        try {
          // If response is from reasoning do not send it.
          if (!content.text) {
            return [];
          }

          let sentMessages: boolean | Message.TextMessage[] = false;
          // channelType target === 'telegram'
          if (content.channelType === "DM") {
            // Route through sendMessageInChunks so DM replies get the same
            // markdown conversion + inline interactions as group replies. Target
            // ctx.from.id (the user's private chat) via a ctx shim, since a DM
            // response to a group message must not go to ctx.chat.id.
            sentMessages = ctx.from
              ? await this.sendMessageInChunks(
                  {
                    chat: { id: ctx.from.id },
                    telegram: this.bot.telegram,
                  } as Context,
                  content,
                )
              : [];
          } else {
            sentMessages = await this.sendMessageInChunks(
              ctx,
              content,
              message.message_id,
            );
          }

          if (!Array.isArray(sentMessages)) {
            return [];
          }

          return this.persistSentMessageMemories({
            sentMessages,
            content,
            roomId,
            channelType,
            chatType: chat.type,
            threadId,
            inReplyTo: messageId,
          });
        } catch (error) {
          logger.error(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Error in message callback",
          );
          return [];
        }
      };
      const callback = createTelegramCompactProgressCallback({
        baseCallback,
        editMessage: this.editMessage.bind(this),
        chatId: chat.id,
        threadId: threadIdNum,
      });

      // Inbound messages are always persisted to memory above. The agent only
      // auto-generates a reply when TELEGRAM_AUTO_REPLY is explicitly enabled —
      // default-off prevents the runtime from speaking on the user's behalf.
      // A forced reply (explicit slash-command invocation) always routes to the
      // agent regardless of the auto-reply gate, since the user explicitly asked
      // for a response by typing a command.
      const telegramAutoReplyRaw = this.runtime.getSetting(
        "TELEGRAM_AUTO_REPLY",
      );
      const telegramAutoReply =
        !lifeOpsPassiveConnectorsEnabled(this.runtime) &&
        (telegramAutoReplyRaw === true || telegramAutoReplyRaw === "true");
      const shouldReply = options?.forceReply === true || telegramAutoReply;

      if (!shouldReply) {
        try {
          await this.runtime.createMemory(memory, "messages");
        } catch (persistError) {
          logger.warn(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              error:
                persistError instanceof Error
                  ? persistError.message
                  : String(persistError),
            },
            "Failed to persist inbound memory while auto-reply is disabled",
          );
        }
        logger.debug(
          { src: "plugin:telegram", agentId: this.runtime.agentId },
          "Auto-reply disabled (TELEGRAM_AUTO_REPLY=false); message ingested without response",
        );
      } else if (this.runtime.messageService) {
        await this.runtime.messageService.handleMessage(
          this.runtime,
          memory,
          callback,
        );
      } else {
        logger.error(
          { src: "plugin:telegram", agentId: this.runtime.agentId },
          "Message service is not available",
        );
        throw new Error(
          "Message service is not initialized. Ensure the message service is properly configured.",
        );
      }
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          chatId: ctx.chat?.id,
          messageId: ctx.message.message_id,
          from: ctx.from.username || ctx.from.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error handling Telegram message",
      );
      throw error;
    }
  }

  /**
   * Handle an inline-keyboard button tap whose payload was produced by the
   * shared interaction codec (a choice or followup answer). The chosen value is
   * replayed as an ordinary user turn — mirroring the dashboard's "send the
   * chosen value as a message" behavior — so downstream routing (choice scopes,
   * orchestrator turns) is identical across surfaces. Foreign callbacks are
   * acknowledged and ignored.
   */
  public async handleCallbackQuery(
    ctx: NarrowedContext<Context<Update>, Update.CallbackQueryUpdate>,
  ): Promise<void> {
    const query = ctx.callbackQuery;
    const data =
      query && "data" in query && typeof query.data === "string"
        ? query.data
        : undefined;
    const decoded = decodeCallback(data);

    if (!decoded || !ctx.from || !query?.message) {
      try {
        await ctx.answerCbQuery();
      } catch {
        // best-effort: a stale callback may already have expired
      }
      return;
    }

    const sourceMessage = query.message;
    const chat = sourceMessage.chat as Chat;
    const telegramUserId = ctx.from.id.toString();
    const entityId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(telegramUserId),
    ) as UUID;

    const threadId =
      "is_topic_message" in sourceMessage && sourceMessage.is_topic_message
        ? sourceMessage.message_thread_id?.toString()
        : undefined;
    const threadIdNum =
      threadId && Number.isFinite(Number(threadId))
        ? Number(threadId)
        : undefined;
    const telegramChatId = chat.id.toString();
    const telegramRoomid = threadId
      ? `${telegramChatId}-${threadId}`
      : telegramChatId;
    const roomId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(telegramRoomid),
    ) as UUID;
    const worldId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(telegramChatId),
    ) as UUID;
    // Derive the turn id from the unique callback-query id so it never collides
    // with the bot message the buttons were attached to.
    const callbackKey = `cbq-${query.id}`;
    const messageId = createUniqueUuid(
      this.runtime,
      this.scopedTelegramKey(callbackKey),
    );
    const channelType = getChannelType(chat);
    const computerUseApproval = parseComputerUseApprovalCallback(decoded.value);
    if (computerUseApproval) {
      await this.resolveComputerUseApprovalCallback(
        ctx,
        chat,
        sourceMessage.message_id,
        threadIdNum,
        entityId,
        roomId,
        channelType,
        computerUseApproval,
      );
      return;
    }

    // Always acknowledge so Telegram clears the button's loading spinner.
    try {
      await ctx.answerCbQuery();
    } catch {
      // best-effort: a stale callback may already have expired
    }

    await this.runtime.ensureConnection({
      entityId,
      roomId,
      roomName: telegramRoomid,
      userName: ctx.from.username,
      name: ctx.from.first_name,
      userId: telegramUserId as UUID,
      source: "telegram",
      channelId: telegramRoomid,
      type: channelType,
      worldId,
      worldName: telegramRoomid,
    });

    const nowMs = Date.now();
    const memory: Memory = {
      id: messageId,
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      content: {
        text: decoded.value,
        source: "telegram",
        metadata: { accountId: this.accountId },
        channelType,
      },
      metadata: {
        type: "message",
        source: "telegram",
        accountId: this.accountId,
        provider: "telegram",
        timestamp: nowMs,
        entityName: ctx.from.first_name,
        entityUserName: ctx.from.username,
        fromBot: false,
        fromId: telegramUserId,
        sourceId: entityId,
        chatType: chat.type,
        messageIdFull: callbackKey,
        sender: {
          id: telegramUserId,
          name: ctx.from.first_name,
          username: ctx.from.username,
        },
        telegram: {
          ...telegramIdentityMetadata(
            telegramUserId,
            ctx.from.first_name,
            ctx.from.username,
          ),
          chatId: telegramChatId,
          messageId: callbackKey,
          threadId,
        },
        telegramUserId,
        telegramChatId,
      } satisfies Memory["metadata"],
      createdAt: nowMs,
    };

    const baseCallback: HandlerCallback = async (content: Content) => {
      const sentMessages = await this.sendMessageInChunks(
        ctx,
        content,
        sourceMessage.message_id,
        threadIdNum,
      );
      return this.persistSentMessageMemories({
        sentMessages,
        content,
        roomId,
        channelType,
        chatType: chat.type,
        threadId,
        inReplyTo: messageId,
      });
    };
    const callback = createTelegramCompactProgressCallback({
      baseCallback,
      editMessage: this.editMessage.bind(this),
      chatId: chat.id,
      threadId: threadIdNum,
    });

    if (this.runtime.messageService) {
      await this.runtime.messageService.handleMessage(
        this.runtime,
        memory,
        callback,
      );
    }
  }

  private async persistComputerUseApprovalDecisionMemory(args: {
    ctx: NarrowedContext<Context<Update>, Update.CallbackQueryUpdate>;
    chat: Chat;
    roomId: UUID;
    entityId: UUID;
    channelType: ChannelType;
    callback: ComputerUseApprovalCallback;
    statusText: string;
  }): Promise<void> {
    const queryId = args.ctx.callbackQuery.id;
    const actorTelegramUserId = args.ctx.from.id.toString();
    const nowMs = Date.now();
    const memory: Memory = {
      id: createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(`cua-${queryId}`),
      ),
      entityId: args.entityId,
      agentId: this.runtime.agentId,
      roomId: args.roomId,
      content: {
        text: args.statusText,
        source: "telegram",
        channelType: args.channelType,
        metadata: {
          accountId: this.accountId,
          computeruse: {
            approvalId: args.callback.approvalId,
            approved: args.callback.approved,
            ownerId: args.callback.ownerId,
          },
        },
      },
      metadata: {
        type: "custom",
        eventType: "computeruse_approval",
        source: "telegram",
        accountId: this.accountId,
        provider: "telegram",
        timestamp: nowMs,
        entityName: args.ctx.from.first_name,
        entityUserName: args.ctx.from.username,
        fromBot: false,
        fromId: actorTelegramUserId,
        sourceId: args.entityId,
        chatType: args.chat.type,
        messageIdFull: `cua-${queryId}`,
        sender: {
          id: actorTelegramUserId,
          name: args.ctx.from.first_name,
          username: args.ctx.from.username,
        },
        telegram: {
          ...telegramIdentityMetadata(
            actorTelegramUserId,
            args.ctx.from.first_name,
            args.ctx.from.username,
          ),
          chatId: args.chat.id.toString(),
          messageId: `cua-${queryId}`,
        },
        telegramUserId: actorTelegramUserId,
        telegramChatId: args.chat.id.toString(),
        computeruse: {
          approvalId: args.callback.approvalId,
          approved: args.callback.approved,
          ownerId: args.callback.ownerId,
        },
      } satisfies Memory["metadata"],
      createdAt: nowMs,
    };

    try {
      await this.runtime.createMemory(memory, "messages");
    } catch (error) {
      logger.warn(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          approvalId: args.callback.approvalId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to persist computer-use approval decision memory",
      );
    }
  }

  private async resolveComputerUseApprovalCallback(
    ctx: NarrowedContext<Context<Update>, Update.CallbackQueryUpdate>,
    chat: Chat,
    messageId: number,
    threadId: number | undefined,
    entityId: UUID,
    roomId: UUID,
    channelType: ChannelType,
    callback: ComputerUseApprovalCallback,
  ): Promise<void> {
    const service = this.runtime.getService("computeruse");
    const actorTelegramUserId = ctx.from?.id.toString();
    if (
      callback.ownerId &&
      actorTelegramUserId &&
      callback.ownerId !== actorTelegramUserId
    ) {
      try {
        await ctx.answerCbQuery(
          "Only the requester can resolve this approval.",
          {
            show_alert: true,
          },
        );
      } catch {
        // best-effort: a stale callback may already have expired
      }
      return;
    }

    let statusText: string;

    if (!isComputerUseApprovalResolver(service)) {
      statusText = "Computer-use approval service is unavailable.";
    } else {
      const resolution = await Promise.resolve(
        service.resolveApproval(
          callback.approvalId,
          callback.approved,
          "Resolved from Telegram inline button",
        ),
      );
      if (resolution) {
        statusText = `Computer-use approval ${callback.approved ? "approved" : "denied"} (${callback.approvalId}).`;
      } else {
        statusText = `Computer-use approval ${callback.approvalId} is no longer pending.`;
      }
    }

    try {
      await ctx.answerCbQuery(
        callback.approved ? "Approval accepted." : "Approval denied.",
      );
    } catch {
      // best-effort: a stale callback may already have expired
    }

    await this.persistComputerUseApprovalDecisionMemory({
      ctx,
      chat,
      roomId,
      entityId,
      channelType,
      callback,
      statusText,
    });

    try {
      await this.editMessage(chat.id, messageId, statusText, threadId);
    } catch (error) {
      logger.warn(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          approvalId: callback.approvalId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to edit computer-use approval prompt; sending a status reply",
      );
      await this.sendMessageInChunks(
        ctx.chat ? ctx : ({ chat, telegram: this.bot.telegram } as Context),
        { text: statusText },
        messageId,
        threadId,
      );
    }
  }

  /**
   * Handles the reaction event triggered by a user reacting to a message.
   * @param {NarrowedContext<Context<Update>, Update.MessageReactionUpdate>} ctx The context of the message reaction update
   * @returns {Promise<void>} A Promise that resolves when the reaction handling is complete
   */
  public async handleReaction(
    ctx: NarrowedContext<Context<Update>, Update.MessageReactionUpdate>,
  ): Promise<void> {
    // Ensure we have the necessary data
    if (!ctx.update.message_reaction || !ctx.from) {
      return;
    }

    const reaction = ctx.update.message_reaction;
    const reactedToMessageId = reaction.message_id;

    const syntheticReactionMessage = {
      message_id: reactedToMessageId,
      chat: reaction.chat,
      from: ctx.from,
      date: Math.floor(Date.now() / 1000),
    } as Message;

    const firstReaction = reaction.new_reaction[0];
    if (!firstReaction) {
      return;
    }
    // Emoji reactions carry the glyph on `.emoji`; non-emoji reactions
    // (custom_emoji / paid) are identified by `.type`.
    const reactionLabel =
      firstReaction.type === "emoji" ? firstReaction.emoji : firstReaction.type;

    try {
      const entityId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(ctx.from.id.toString()),
      ) as UUID;
      const roomId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(ctx.chat.id.toString()),
      );

      const reactionId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(
          `${reaction.message_id}-${ctx.from.id}-${Date.now()}`,
        ),
      );

      // Create reaction memory
      const memory: Memory = {
        id: reactionId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          channelType: getChannelType(reaction.chat as Chat),
          text: `Reacted with: ${reactionLabel}`,
          source: "telegram",
          inReplyTo: createUniqueUuid(
            this.runtime,
            this.scopedTelegramKey(reaction.message_id.toString()),
          ),
          metadata: { accountId: this.accountId },
        },
        metadata: {
          type: "custom",
          eventType: "reaction",
          source: "telegram",
          accountId: this.accountId,
          provider: "telegram",
          entityName: ctx.from.first_name,
          entityUserName: ctx.from.username,
          fromBot: ctx.from.is_bot,
          fromId: ctx.from.id.toString(),
          sourceId: entityId,
          sender: {
            id: ctx.from.id.toString(),
            name: ctx.from.first_name,
            username: ctx.from.username,
          },
          telegram: {
            ...telegramIdentityMetadata(
              ctx.from.id.toString(),
              ctx.from.first_name,
              ctx.from.username,
            ),
            chatId: reaction.chat.id.toString(),
            messageId: reaction.message_id.toString(),
          },
          telegramUserId: ctx.from.id.toString(),
          telegramChatId: reaction.chat.id.toString(),
        } satisfies Memory["metadata"],
        createdAt: Date.now(),
      };

      // Create callback for handling reaction responses
      const callback: HandlerCallback = async (content: Content) => {
        try {
          // Add null check for content.text
          const replyText = content.text ?? "";
          const sentMessage = await ctx.reply(replyText);
          const responseMemory: Memory = {
            id: createUniqueUuid(
              this.runtime,
              this.scopedTelegramKey(sentMessage.message_id.toString()),
            ),
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            roomId,
            content: {
              ...content,
              inReplyTo: reactionId,
              metadata: { accountId: this.accountId },
            },
            metadata: {
              type: "message",
              source: "telegram",
              accountId: this.accountId,
              provider: "telegram",
            } satisfies Memory["metadata"],
            createdAt: sentMessage.date * 1000,
          };
          return [responseMemory];
        } catch (error) {
          logger.error(
            {
              src: "plugin:telegram",
              agentId: this.runtime.agentId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Error in reaction callback",
          );
          return [];
        }
      };

      // Let the bootstrap plugin handle the reaction
      this.runtime.emitEvent(EventType.REACTION_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: "telegram",
        accountId: this.accountId,
        metadata: { accountId: this.accountId },
        ctx,
        originalMessage: syntheticReactionMessage,
        reactionString: reactionLabel,
        originalReaction: firstReaction as ReactionType,
      } as TelegramReactionReceivedPayload);

      // Also emit the platform-specific event
      this.runtime.emitEvent(TelegramEventTypes.REACTION_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: "telegram",
        accountId: this.accountId,
        metadata: { accountId: this.accountId },
        ctx,
        originalMessage: syntheticReactionMessage,
        reactionString: reactionLabel,
        originalReaction: firstReaction as ReactionType,
      } as TelegramReactionReceivedPayload);
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error handling reaction",
      );
    }
  }

  /**
   * Edits the text of a previously-sent Telegram message in place. Converts
   * markdown to MarkdownV2 and, on a MarkdownV2 rejection, retries as plain
   * text — mirroring {@link sendMessageInChunks}'s fallback. Used by the
   * connector `edit_message` capability so the orchestrator's compact progress
   * mode can rewrite one line across heartbeats instead of flooding the chat.
   */
  public async editMessage(
    chatId: number | string,
    messageId: number,
    text: string,
    messageThreadId?: number,
  ): Promise<void> {
    const formatted = convertMarkdownToTelegram(text);
    await this.sendWithRetry(
      () =>
        this.bot.telegram.editMessageText(
          chatId,
          messageId,
          undefined,
          formatted,
          { parse_mode: "MarkdownV2" },
        ),
      // Fallback: Telegram rejected the MarkdownV2 — edit with the raw text so
      // the user sees the content unformatted rather than a stale message.
      () =>
        this.bot.telegram.editMessageText(
          chatId,
          messageId,
          undefined,
          cleanText(text),
        ),
    );
    logger.info(
      {
        src: "plugin:telegram",
        agentId: this.runtime.agentId,
        chatId,
        messageId,
        messageThreadId,
      },
      "Message edited",
    );
  }

  /**
   * Sets a single emoji reaction on a Telegram message, or clears the bot's
   * reactions when `emoji` is undefined. Used by the connector `react_message`
   * capability.
   */
  public async addReaction(
    chatId: number | string,
    messageId: number,
    emoji?: string,
  ): Promise<void> {
    await this.bot.telegram.setMessageReaction(
      chatId,
      messageId,
      // Telegram only accepts a fixed set of reaction emoji (the `TelegramEmoji`
      // union); the connector passes an arbitrary string, so cast and let
      // Telegram reject an unsupported emoji at the API boundary.
      emoji ? [{ type: "emoji", emoji } as ReactionType] : [],
    );
    logger.info(
      {
        src: "plugin:telegram",
        agentId: this.runtime.agentId,
        chatId,
        messageId,
        emoji: emoji ?? "(cleared)",
      },
      "Message reaction set",
    );
  }

  /**
   * Sends a message to a Telegram chat and emits appropriate events
   * @param {number | string} chatId - The Telegram chat ID to send the message to
   * @param {Content} content - The content to send
   * @param {number} [replyToMessageId] - Optional message ID to reply to
   * @returns {Promise<Message.TextMessage[]>} The sent messages
   */
  public async sendMessage(
    chatId: number | string,
    content: Content,
    replyToMessageId?: number,
    messageThreadId?: number,
  ): Promise<Message.TextMessage[]> {
    try {
      // Create a context-like object for sending
      const ctx = {
        chat: { id: chatId },
        telegram: this.bot.telegram,
      };

      const sentMessages = await this.sendMessageInChunks(
        ctx as Context,
        content,
        replyToMessageId,
        messageThreadId,
      );

      if (!sentMessages.length) {
        return [];
      }

      // Create group ID
      const roomKey = messageThreadId
        ? `${chatId.toString()}-${messageThreadId}`
        : chatId.toString();
      const roomId = createUniqueUuid(
        this.runtime,
        this.scopedTelegramKey(roomKey),
      );

      // Create memories for the sent messages
      const memories: Memory[] = [];
      const contentMetadata =
        content.metadata &&
        typeof content.metadata === "object" &&
        !Array.isArray(content.metadata)
          ? content.metadata
          : {};
      for (const sentMessage of sentMessages) {
        const memory: Memory = {
          id: createUniqueUuid(
            this.runtime,
            this.scopedTelegramKey(sentMessage.message_id.toString()),
          ),
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId,
          content: {
            ...content,
            text: sentMessage.text,
            source: "telegram",
            metadata: { ...contentMetadata, accountId: this.accountId },
            channelType: getChannelType({
              id:
                typeof chatId === "string"
                  ? Number.parseInt(chatId, 10)
                  : chatId,
              type: "private", // Default to private, will be overridden if in context
            } as Chat),
            ...(messageThreadId
              ? {
                  metadata: {
                    ...contentMetadata,
                    accountId: this.accountId,
                    threadId: messageThreadId,
                  },
                }
              : {}),
          },
          metadata: {
            type: "message",
            source: "telegram",
            accountId: this.accountId,
            provider: "telegram",
            fromBot: true,
            fromId: this.runtime.agentId,
            sourceId: this.runtime.agentId,
            messageIdFull: sentMessage.message_id.toString(),
            telegram: {
              chatId: sentMessage.chat.id.toString(),
              messageId: sentMessage.message_id.toString(),
              threadId: messageThreadId?.toString(),
            },
          } satisfies Memory["metadata"],
          createdAt: sentMessage.date * 1000,
        };

        await this.runtime.createMemory(memory, "messages");
        memories.push(memory);
      }

      // Emit both generic and platform-specific message sent events
      if (memories.length > 0) {
        const firstMemory = memories[0];
        this.runtime.emitEvent(EventType.MESSAGE_SENT, {
          runtime: this.runtime,
          message: firstMemory,
          source: "telegram",
          accountId: this.accountId,
          metadata: { accountId: this.accountId },
        } as MessagePayload & {
          accountId: string;
          metadata: { accountId: string };
        });

        // Also emit platform-specific event
        const telegramMessageSentPayload = {
          runtime: this.runtime,
          source: "telegram",
          accountId: this.accountId,
          metadata: { accountId: this.accountId },
          originalMessages: sentMessages,
          chatId,
          message: firstMemory,
        } as TelegramMessageSentPayload & {
          accountId: string;
          metadata: { accountId: string };
        };
        this.runtime.emitEvent(
          TelegramEventTypes.MESSAGE_SENT as string,
          telegramMessageSentPayload,
        );
      }

      return sentMessages;
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: this.runtime.agentId,
          chatId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error sending message to Telegram",
      );
      return [];
    }
  }
}
