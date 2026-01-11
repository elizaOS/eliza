import {
  type IAgentRuntime,
  logger,
  type Media,
  ModelType,
  parseJSONObjectFromText,
  trimTokens,
} from "@elizaos/core";
import {
  ActionRowBuilder,
  type AttachmentBuilder,
  ButtonBuilder,
  ChannelType,
  type Message as DiscordMessage,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
  PermissionsBitField,
  StringSelectMenuBuilder,
  type TextChannel,
  ThreadChannel,
} from "discord.js";
import type { DiscordActionRow, DiscordComponentOptions, JsonValue } from "./types";

/**
 * Type definition for the unified messaging API available on some runtime versions.
 */
export interface UnifiedMessagingAPI {
  sendMessage: (
    agentId: string,
    message: unknown,
    options?: { onResponse?: unknown }
  ) => Promise<unknown>;
}

/**
 * Type definition for the message service available on newer core versions.
 */
export interface MessageServiceAPI {
  handleMessage: (runtime: IAgentRuntime, message: unknown, callback: unknown) => Promise<unknown>;
}

/**
 * Checks if the runtime has the unified messaging API (elizaOS.sendMessage).
 * @param {IAgentRuntime} runtime - The runtime to check
 * @returns {boolean} True if the unified messaging API is available
 */
export function hasUnifiedMessagingAPI(runtime: IAgentRuntime): boolean {
  const runtimeAny = runtime as { elizaOS?: { sendMessage?: unknown } };
  return !!(runtimeAny.elizaOS && typeof runtimeAny.elizaOS.sendMessage === "function");
}

/**
 * Checks if the runtime has the message service API (messageService.handleMessage).
 * @param {IAgentRuntime} runtime - The runtime to check
 * @returns {boolean} True if the message service API is available
 */
export function hasMessageService(runtime: IAgentRuntime): boolean {
  const runtimeAny = runtime as {
    messageService?: { handleMessage?: unknown };
  };
  return !!(
    typeof runtimeAny.messageService === "object" &&
    runtimeAny.messageService &&
    typeof runtimeAny.messageService.handleMessage === "function"
  );
}

/**
 * Gets the unified messaging API if available.
 * @param {IAgentRuntime} runtime - The runtime to get the API from
 * @returns {UnifiedMessagingAPI | null} The unified messaging API or null if not available
 */
export function getUnifiedMessagingAPI(runtime: IAgentRuntime): UnifiedMessagingAPI | null {
  if (hasUnifiedMessagingAPI(runtime)) {
    return (runtime as unknown as { elizaOS: UnifiedMessagingAPI }).elizaOS;
  }
  return null;
}

/**
 * Gets the message service if available.
 * @param {IAgentRuntime} runtime - The runtime to get the service from
 * @returns {MessageServiceAPI | null} The message service or null if not available
 */
export function getMessageService(runtime: IAgentRuntime): MessageServiceAPI | null {
  if (hasMessageService(runtime)) {
    return (runtime as { messageService: MessageServiceAPI }).messageService;
  }
  return null;
}

export const MAX_MESSAGE_LENGTH = 1900;

/**
 * Cleans a URL by removing common trailing junk from Discord messages:
 * - Markdown escape backslashes (t\.co -> t.co)
 * - Markdown link leakage (url](url -> url)
 * - Trailing punctuation and markdown (*_/.,;!>)
 * - Trailing full-width/CJK punctuation (（）［］、。etc.)
 * Preserves valid non-ASCII path characters for internationalized URLs
 *
 * @param {string} url - The raw URL to clean
 * @returns {string} The cleaned URL
 */
export function cleanUrl(url: string): string {
  let clean = url;

  // 1. Remove markdown escape backslashes (e.g. "t\.co" -> "t.co")
  clean = clean.replace(/\\([._\-~])/g, "$1");

  // 2. Handle markdown link leakage (e.g. "url](url" or "](url")
  // Only truncate if we detect the markdown link pattern "](url" which indicates
  // markdown syntax has leaked into the URL. Valid URLs can contain brackets
  // (e.g., query params like "?param[0]=value", IPv6 addresses, fragments).
  if (clean.startsWith("](")) {
    // URL starts with markdown link syntax leakage - extract the URL after "]("
    clean = clean.substring(2);
  } else {
    const markdownLinkPattern = /\]\(/;
    const markdownPatternIdx = clean.search(markdownLinkPattern);
    if (markdownPatternIdx > -1) {
      // Found markdown link pattern - truncate at the ']' character
      // This handles cases like "text](https://example.com" where markdown syntax leaked
      clean = clean.substring(0, markdownPatternIdx);
    }
  }
  // Trailing brackets handled by the trailing junk removal step below

  // 3. Remove trailing junk in a loop - handles layered issues like:
  //    - Punctuation/markdown: "site.com**" -> "site.com"
  //    - Full-width punctuation: "site.com）" -> "site.com"
  //    - Mixed: "site.com/path）**" -> "site.com/path"
  // NOTE: We only remove specific problematic characters, not all non-ASCII,
  // to preserve valid internationalized URLs (e.g., https://ja.wikipedia.org/wiki/日本)
  // NOTE: We don't strip forward slashes as they're valid and semantically meaningful in URLs
  let prev = "";
  while (prev !== clean) {
    prev = clean;
    // Strip trailing ASCII punctuation and markdown (but NOT forward slashes)
    clean = clean.replace(/[)\]>.,;!*_]+$/, "");
    // Strip only specific trailing full-width/CJK punctuation characters
    // that are commonly appended as junk (NOT all non-ASCII characters)
    // Includes: full-width parens （）, brackets ［］【】, punctuation 、。！？etc.
    clean = clean.replace(/[（）［］【】｛｝《》〈〉「」『』、。，．；：！？~～]+$/, "");
  }

  return clean;
}

/**
 * Extracts and cleans URLs from text content.
 * Handles Discord-specific URL formatting issues.
 *
 * @param {string} text - The text to extract URLs from
 * @param {IAgentRuntime} [runtime] - Optional runtime for debug logging
 * @returns {string[]} Array of cleaned, valid URLs
 */
export function extractUrls(text: string, runtime?: IAgentRuntime): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const rawUrls = text.match(urlRegex) || [];

  return rawUrls
    .map((url) => {
      const original = url;
      const clean = cleanUrl(url);

      // Debug log if URL was cleaned
      if (runtime && original !== clean) {
        runtime.logger.debug(`URL cleaned: "${original}" -> "${clean}"`);
      }

      return clean;
    })
    .filter((url) => {
      // Basic validation to ensure it's still a valid URL after cleanup
      try {
        new URL(url);
        return true;
      } catch {
        if (runtime) {
          runtime.logger.debug(`Invalid URL after cleanup, skipping: "${url}"`);
        }
        return false;
      }
    });
}

/**
 * Generates a filename with proper extension from Media object.
 * Extracts extension from URL if available, otherwise infers from contentType.
 *
 * @param {Media} media - The media object to generate filename for.
 * @returns {string} A filename with appropriate extension.
 */
export function getAttachmentFileName(media: Media): string {
  // Try to extract extension from URL first
  let extension = "";
  try {
    const urlPath = new URL(media.url).pathname;
    const urlExtension = urlPath.substring(urlPath.lastIndexOf("."));
    if (urlExtension && urlExtension.length > 1 && urlExtension.length <= 5) {
      extension = urlExtension;
    }
  } catch {
    // If URL parsing fails, try simple string extraction
    const lastDot = media.url.lastIndexOf(".");
    const queryStart = media.url.indexOf("?", lastDot);
    if (lastDot > 0 && (queryStart === -1 || queryStart > lastDot + 1)) {
      const potentialExt = media.url.substring(lastDot, queryStart > -1 ? queryStart : undefined);
      if (potentialExt.length > 1 && potentialExt.length <= 5) {
        extension = potentialExt;
      }
    }
  }

  // If no extension from URL, infer from contentType
  if (!extension && media.contentType) {
    const contentTypeMap: Record<string, string> = {
      image: ".png",
      video: ".mp4",
      audio: ".mp3",
      document: ".txt",
      link: ".html",
    };
    extension = contentTypeMap[media.contentType] || "";
  }

  // Default to .txt if still no extension (for text/document files)
  if (!extension) {
    extension = ".txt";
  }

  // Get base name from title or id
  const baseName = media.title || media.id || "attachment";

  // Check if base name already has an extension
  const hasExtension = /\.\w{1,5}$/i.test(baseName);

  // Return filename with extension
  return hasExtension ? baseName : `${baseName}${extension}`;
}

/**
 * Generates a summary for a given text using a specified model.
 *
 * @param {IAgentRuntime} runtime - The IAgentRuntime instance.
 * @param {string} text - The text for which to generate a summary.
 * @returns {Promise<{ title: string; description: string }>} An object containing the generated title and summary.
 */
export async function generateSummary(
  runtime: IAgentRuntime,
  text: string
): Promise<{ title: string; description: string }> {
  // make sure text is under 128k characters
  text = await trimTokens(text, 100000, runtime);

  if (!text) {
    return {
      title: "",
      description: "",
    };
  }

  // Optimization: If text is short enough, do not invoke LLM for summary
  // 1000 characters is roughly 200-250 words, which is already concise enough
  if (text.length < 1000) {
    return {
      title: "", // Caller will provide default title
      description: text,
    };
  }

  runtime.logger.info(
    `[Summarization] Calling TEXT_SMALL for ${text.length} chars: "${text.substring(0, 50).replace(/\n/g, " ")}..."`
  );

  const prompt = `Please generate a concise summary for the following text:

  Text: """
  ${text}
  """

  Respond with a JSON object in the following format:
  \`\`\`json
  {
    "title": "Generated Title",
    "summary": "Generated summary and/or description of the text"
  }
  \`\`\``;

  const response = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
  });

  const parsedResponse = parseJSONObjectFromText(response) as {
    title?: string;
    summary?: string;
  } | null;

  if (
    parsedResponse &&
    typeof parsedResponse.title === "string" &&
    typeof parsedResponse.summary === "string"
  ) {
    return {
      title: parsedResponse.title,
      description: parsedResponse.summary,
    };
  }

  return {
    title: "",
    description: "",
  };
}

/**
 * Discord API error structure
 */
interface DiscordAPIError extends Error {
  code?: number;
}

/**
 * Type guard for Discord API errors
 */
function isDiscordAPIError(error: unknown): error is DiscordAPIError {
  return error instanceof Error && "code" in error;
}

/**
 * Discord.js component with toJSON method
 */
interface DiscordJsComponent {
  toJSON(): JsonValue;
}

/**
 * Type guard for Discord.js components
 */
function isDiscordJsComponent(component: unknown): component is DiscordJsComponent {
  return (
    component !== null &&
    typeof component === "object" &&
    "toJSON" in component &&
    typeof (component as DiscordJsComponent).toJSON === "function"
  );
}

/**
 * Safe JSON stringify that handles BigInt values
 */
function safeStringify(obj: unknown): string {
  return JSON.stringify(obj, (_, value) => (typeof value === "bigint" ? value.toString() : value));
}

/**
 * Message send options for Discord
 */
interface MessageSendOptions {
  content: string;
  reply?: {
    messageReference: string;
  };
  files?: Array<AttachmentBuilder | { attachment: Buffer | string; name: string }>;
  // Use ActionRowBuilder[] for components, cast to MessageCreateOptions when sending
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

/**
 * Sends a message in chunks to a specified Discord TextChannel.
 * @param {TextChannel} channel - The Discord TextChannel to send the message to.
 * @param {string} content - The content of the message to be sent.
 * @param {string} inReplyTo - The message ID to reply to (if applicable).
 * @param {Array} files - Array of files to attach to the message (AttachmentBuilder or plain objects).
 * @param {DiscordActionRow[]} components - Optional components to add to the message (buttons, dropdowns, etc.).
 * @returns {Promise<DiscordMessage[]>} - Array of sent Discord messages.
 */
export async function sendMessageInChunks(
  channel: TextChannel,
  content: string,
  inReplyTo: string,
  files: Array<AttachmentBuilder | { attachment: Buffer | string; name: string }>,
  components?: DiscordActionRow[],
  runtime?: IAgentRuntime
): Promise<DiscordMessage[]> {
  const sentMessages: DiscordMessage[] = [];

  // Use smart splitting if runtime available and content is complex
  let messages: string[];
  if (runtime && content.length > MAX_MESSAGE_LENGTH && needsSmartSplit(content)) {
    messages = await smartSplitMessage(runtime, content);
  } else {
    messages = splitMessage(content);
  }
  try {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (
        message.trim().length > 0 ||
        (i === messages.length - 1 && files && files.length > 0) ||
        components
      ) {
        const options: MessageSendOptions = {
          content: message.trim(),
        };

        // Reply to the specified message for the first chunk
        if (i === 0 && inReplyTo) {
          // Enable reply threading for first message chunk if inReplyTo is provided
          options.reply = {
            messageReference: inReplyTo,
          };
        }

        // Attach files to the last message chunk
        if (i === messages.length - 1 && files && files.length > 0) {
          options.files = files;
        }

        // Add components to the last message or to a message with components only
        if (i === messages.length - 1 && components && components.length > 0) {
          try {
            logger.info(`Components received: ${safeStringify(components)}`);

            if (!Array.isArray(components)) {
              logger.warn("Components is not an array, skipping component processing");
              // Instead of continue, maybe return or handle differently?
              // For now, let's proceed assuming it might be an empty message with components
            } else if (
              components.length > 0 &&
              components[0] &&
              isDiscordJsComponent(components[0])
            ) {
              // If it looks like discord.js components, pass them directly
              options.components =
                components as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>[];
            } else {
              // Otherwise, build components from the assumed DiscordActionRow[] structure
              const discordComponents = (components as DiscordActionRow[]) // Cast here for building logic
                .map((row: DiscordActionRow) => {
                  if (!row || typeof row !== "object" || row.type !== 1) {
                    logger.warn("Invalid component row structure, skipping");
                    return null;
                  }

                  if (row.type === 1) {
                    const actionRow = new ActionRowBuilder<MessageActionRowComponentBuilder>();

                    if (!Array.isArray(row.components)) {
                      logger.warn("Row components is not an array, skipping");
                      return null;
                    }

                    const validComponents = row.components
                      .map((comp: DiscordComponentOptions) => {
                        if (!comp || typeof comp !== "object") {
                          logger.warn("Invalid component, skipping");
                          return null;
                        }

                        try {
                          if (comp.type === 2) {
                            return new ButtonBuilder()
                              .setCustomId(comp.custom_id)
                              .setLabel(comp.label || "")
                              .setStyle(comp.style || 1);
                          }

                          if (comp.type === 3) {
                            const selectMenu = new StringSelectMenuBuilder()
                              .setCustomId(comp.custom_id)
                              .setPlaceholder(comp.placeholder || "Select an option");

                            if (typeof comp.min_values === "number") {
                              selectMenu.setMinValues(comp.min_values);
                            }
                            if (typeof comp.max_values === "number") {
                              selectMenu.setMaxValues(comp.max_values);
                            }

                            if (Array.isArray(comp.options)) {
                              selectMenu.addOptions(
                                comp.options.map((option) => ({
                                  label: option.label,
                                  value: option.value,
                                  description: option.description,
                                }))
                              );
                            }

                            return selectMenu;
                          }
                        } catch (err) {
                          logger.error(`Error creating component: ${err}`);
                          return null;
                        }
                        return null;
                      })
                      .filter(Boolean);

                    if (validComponents.length > 0) {
                      actionRow.addComponents(validComponents);
                      return actionRow;
                    }
                  }
                  return null;
                })
                .filter(Boolean);

              if (discordComponents.length > 0) {
                options.components = discordComponents;
              }
            }
          } catch (error) {
            logger.error(`Error processing components: ${error}`);
          }
        }

        try {
          const m = await channel.send(options as MessageCreateOptions);
          sentMessages.push(m);
        } catch (error: unknown) {
          // Handle unknown message reference error
          if (
            isDiscordAPIError(error) &&
            error.code === 50035 &&
            error.message &&
            error.message.includes("Unknown message")
          ) {
            logger.warn(
              "Message reference no longer valid (message may have been deleted). Sending without reply threading."
            );
            // Retry without the reply reference
            const optionsWithoutReply = { ...options };
            delete optionsWithoutReply.reply;
            try {
              const m = await channel.send(optionsWithoutReply as MessageCreateOptions);
              sentMessages.push(m);
            } catch (retryError: unknown) {
              const errorMessage =
                retryError instanceof Error ? retryError.message : String(retryError);
              logger.error(`Error sending message after removing reply reference: ${errorMessage}`);
              throw retryError;
            }
          } else {
            // Re-throw other errors
            throw error;
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Error sending message: ${error}`);
  }

  return sentMessages;
}

/**
 * Detects if content needs smart (LLM-based) splitting or can use simple line-based splitting.
 * Smart splitting is useful for:
 * - Code blocks that shouldn't be split mid-block
 * - Markdown with headers and sections
 * - Numbered lists that should stay together
 *
 * @param {string} content - The content to analyze
 * @returns {boolean} True if smart splitting would be beneficial
 */
export function needsSmartSplit(content: string): boolean {
  // Check for code blocks - these shouldn't be split mid-block
  const codeBlockCount = (content.match(/```/g) || []).length;
  if (codeBlockCount >= 2) {
    return true;
  }

  // Check for markdown headers - content has structure
  if (/^#{1,3}\s/m.test(content)) {
    return true;
  }

  // Check for numbered lists (1. 2. 3.) - should stay together when possible
  if (/^\d+\.\s/m.test(content)) {
    return true;
  }

  // Check for very long lines without natural breakpoints
  const lines = content.split("\n");
  const hasLongUnbreakableLines = lines.some(
    (line) => line.length > 500 && !line.includes(". ") && !line.includes(", ")
  );
  if (hasLongUnbreakableLines) {
    return true;
  }

  return false;
}

/**
 * Parses a JSON array from a given text. The function looks for a JSON block wrapped in triple backticks
 * with `json` language identifier, and if not found, it attempts to parse the text directly as JSON.
 * Unlike parseJSONObjectFromText from core, this function specifically expects and returns arrays.
 *
 * @param {string} text - The input text from which to extract and parse the JSON array.
 * @returns {JsonValue[] | null} An array parsed from the JSON string if successful; otherwise, null.
 */
function parseJSONArrayFromText(text: string): JsonValue[] | null {
  const jsonBlockPattern = /```json\n([\s\S]*?)\n```/;
  let jsonData: JsonValue = null;
  const jsonBlockMatch = text.match(jsonBlockPattern);

  try {
    if (jsonBlockMatch) {
      // Parse the JSON from inside the code block
      jsonData = JSON.parse(jsonBlockMatch[1].trim()) as JsonValue;
    } else {
      // Try to parse the text directly if it's not in a code block
      jsonData = JSON.parse(text.trim()) as JsonValue;
    }
  } catch (_e) {
    // If parsing fails, return null
    return null;
  }

  // Ensure we have an array
  if (Array.isArray(jsonData)) {
    return jsonData;
  }

  // Return null if not a valid array
  return null;
}

/**
 * Splits content using LLM for semantic breakpoints.
 * Only use when needsSmartSplit() returns true and runtime is available.
 *
 * @param {IAgentRuntime} runtime - The runtime for LLM calls
 * @param {string} content - The content to split
 * @param {number} maxLength - Maximum length per chunk
 * @returns {Promise<string[]>} Array of semantically-split chunks
 */
export async function smartSplitMessage(
  runtime: IAgentRuntime,
  content: string,
  maxLength: number = MAX_MESSAGE_LENGTH
): Promise<string[]> {
  // If content fits, no splitting needed
  if (content.length <= maxLength) {
    return [content];
  }

  // Calculate approximate number of chunks needed
  const estimatedChunks = Math.ceil(content.length / (maxLength - 100));

  try {
    runtime.logger.debug(`Smart splitting ${content.length} chars into ~${estimatedChunks} chunks`);

    const prompt = `Split the following text into ${estimatedChunks} parts for Discord messages (max ${maxLength} chars each).
Keep related content together (don't split code blocks, keep list items with their headers, etc.).
Return ONLY a JSON array of strings, no explanation.

Text to split:
"""
${content}
"""

Return format: ["chunk1", "chunk2", ...]`;

    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });

    // Try to parse as JSON array
    const parsed = parseJSONArrayFromText(response);
    if (Array.isArray(parsed)) {
      // Filter to only valid, non-empty string chunks within size limit
      const validChunks = parsed.filter(
        (chunk: unknown): chunk is string =>
          typeof chunk === "string" && chunk.trim().length > 0 && chunk.length <= maxLength
      );

      // Only use LLM result if we have non-empty chunks
      // This prevents returning empty arrays from responses like ["", ""]
      if (validChunks.length > 0) {
        return validChunks;
      }

      runtime.logger.debug(
        "Smart split returned empty or invalid chunks, falling back to simple split"
      );
    }
  } catch (error) {
    runtime.logger.debug(`Smart split failed, falling back to simple split: ${error}`);
  }

  // Fall back to simple splitting
  return splitMessage(content, maxLength);
}

/**
 * Splits the content into an array of strings based on the maximum message length.
 * Uses simple line-based splitting. For complex content, use smartSplitMessage().
 *
 * @param {string} content - The content to split into messages
 * @param {number} maxLength - Maximum length per message (default: 1900)
 * @returns {string[]} An array of strings that represent the split messages
 */
export function splitMessage(content: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  // If content fits, no splitting needed
  if (!content || content.length <= maxLength) {
    return content ? [content] : [];
  }

  const messages: string[] = [];
  let currentMessage = "";

  const rawLines = content.split("\n");
  // split all lines into maxLength chunks so any long lines are split
  const lines = rawLines.flatMap((line) => {
    const chunks: string[] = [];
    while (line.length > maxLength) {
      // Try to split at word boundary
      let splitIdx = maxLength;
      const lastSpace = line.lastIndexOf(" ", maxLength);

      if (lastSpace > maxLength * 0.7) {
        // Prefer space in the last 30% (good utilization + word boundary)
        splitIdx = lastSpace;
      } else if (lastSpace > maxLength * 0.3) {
        // Fallback: use space in the middle to avoid mid-word splits
        // Only if it's not too early (at least 30% of capacity used)
        splitIdx = lastSpace;
      }
      // Otherwise: no usable space (< 30% or -1), split at maxLength

      chunks.push(line.slice(0, splitIdx));
      line = line.slice(splitIdx).trimStart();
    }
    chunks.push(line);
    return chunks;
  });

  for (const line of lines) {
    if (currentMessage.length + line.length + 1 > maxLength) {
      if (currentMessage.trim().length > 0) {
        messages.push(currentMessage.trim());
      }
      currentMessage = "";
    }
    currentMessage += `${line}\n`;
  }

  if (currentMessage.trim().length > 0) {
    messages.push(currentMessage.trim());
  }

  // Ensure we always return at least one element if we had content to process
  // This prevents errors when whitespace-only content is split
  if (messages.length === 0 && content.length > 0) {
    messages.push(" ");
  }

  return messages;
}

/**
 * Result of checking if the bot can send messages in a channel
 */
export interface CanSendMessageResult {
  canSend: boolean;
  reason: string | null;
  missingPermissions?: bigint[];
}

/**
 * Type for channels that can be checked for send permissions
 */
type SendableChannel = TextChannel | ThreadChannel | { type: ChannelType };

/**
 * Checks if the bot can send messages in a given channel by checking permissions.
 * @param {SendableChannel} channel - The channel to check permissions for.
 * @returns {CanSendMessageResult} Object containing information about whether the bot can send messages or not.
 */
export function canSendMessage(channel: SendableChannel | null | undefined): CanSendMessageResult {
  // validate input
  if (!channel) {
    return {
      canSend: false,
      reason: "No channel given",
    };
  }
  // if it is a DM channel, we can always send messages
  if (channel.type === ChannelType.DM) {
    return {
      canSend: true,
      reason: null,
    };
  }

  // Check if channel is a guild channel with the necessary properties
  if (!("guild" in channel) || !channel.guild) {
    return {
      canSend: false,
      reason: "Not a guild channel",
    };
  }

  const guildChannel = channel as TextChannel | ThreadChannel;
  const botMember = guildChannel.guild.members.cache.get(guildChannel.client.user.id);

  if (!botMember) {
    return {
      canSend: false,
      reason: "Bot member not found in guild",
    };
  }

  // Required permissions for sending messages
  const requiredPermissions: bigint[] = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
  ];

  // Add thread-specific permission if it's a thread
  if (guildChannel instanceof ThreadChannel) {
    requiredPermissions.push(PermissionsBitField.Flags.SendMessagesInThreads);
  }

  // Check permissions
  const permissions = guildChannel.permissionsFor(botMember);

  if (!permissions) {
    return {
      canSend: false,
      reason: "Could not retrieve permissions",
    };
  }

  // Check each required permission
  const missingPermissions = requiredPermissions.filter((perm) => !permissions.has(perm));

  return {
    canSend: missingPermissions.length === 0,
    missingPermissions,
    reason:
      missingPermissions.length > 0
        ? `Missing permissions: ${missingPermissions.map((p) => String(p)).join(", ")}`
        : null,
  };
}
