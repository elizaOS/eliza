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

export interface MessagingAPI {
  sendMessage: (
    agentId: string,
    message: unknown,
    options?: { onResponse?: unknown }
  ) => Promise<unknown>;
}

export interface MessageServiceAPI {
  handleMessage: (runtime: IAgentRuntime, message: unknown, callback: unknown) => Promise<unknown>;
}

interface RuntimeWithMessagingAPI extends IAgentRuntime {
  elizaOS: MessagingAPI;
}

export function hasMessagingAPI(runtime: IAgentRuntime): runtime is RuntimeWithMessagingAPI {
  return (
    "elizaOS" in runtime &&
    typeof (runtime as { elizaOS?: { sendMessage?: unknown } }).elizaOS === "object" &&
    runtime.elizaOS !== null &&
    typeof (runtime.elizaOS as { sendMessage?: unknown }).sendMessage === "function"
  );
}

export function hasMessageService(runtime: IAgentRuntime): boolean {
  return (
    runtime.messageService !== null && typeof runtime.messageService?.handleMessage === "function"
  );
}

export function getMessagingAPI(runtime: IAgentRuntime): MessagingAPI | null {
  if (hasMessagingAPI(runtime)) {
    return runtime.elizaOS;
  }
  return null;
}

export function getMessageService(runtime: IAgentRuntime): MessageServiceAPI | null {
  if (hasMessageService(runtime)) {
    return runtime.messageService;
  }
  return null;
}

export const MAX_MESSAGE_LENGTH = 1900;

export function cleanUrl(url: string): string {
  let clean = url;

  clean = clean.replace(/\\([._\-~])/g, "$1");

  if (clean.startsWith("](")) {
    clean = clean.substring(2);
  } else {
    const markdownLinkPattern = /\]\(/;
    const markdownPatternIdx = clean.search(markdownLinkPattern);
    if (markdownPatternIdx > -1) {
      clean = clean.substring(0, markdownPatternIdx);
    }
  }

  let prev = "";
  while (prev !== clean) {
    prev = clean;
    clean = clean.replace(/[)\]>.,;!*_]+$/, "");
    clean = clean.replace(/[（）［］【】｛｝《》〈〉「」『』、。，．；：！？~～]+$/, "");
  }

  return clean;
}

export function extractUrls(text: string, runtime?: IAgentRuntime): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const rawUrls = text.match(urlRegex) || [];

  return rawUrls
    .map((url) => {
      const original = url;
      const clean = cleanUrl(url);

      if (runtime && original !== clean) {
        runtime.logger.debug(`URL cleaned: "${original}" -> "${clean}"`);
      }

      return clean;
    })
    .filter((url) => {
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

export function getAttachmentFileName(media: Media): string {
  let extension = "";
  try {
    const urlPath = new URL(media.url).pathname;
    const urlExtension = urlPath.substring(urlPath.lastIndexOf("."));
    if (urlExtension && urlExtension.length > 1 && urlExtension.length <= 5) {
      extension = urlExtension;
    }
  } catch {
    const lastDot = media.url.lastIndexOf(".");
    const queryStart = media.url.indexOf("?", lastDot);
    if (lastDot > 0 && (queryStart === -1 || queryStart > lastDot + 1)) {
      const potentialExt = media.url.substring(lastDot, queryStart > -1 ? queryStart : undefined);
      if (potentialExt.length > 1 && potentialExt.length <= 5) {
        extension = potentialExt;
      }
    }
  }

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

  if (!extension) {
    extension = ".txt";
  }

  const baseName = media.title || media.id || "attachment";
  const hasExtension = /\.\w{1,5}$/i.test(baseName);

  return hasExtension ? baseName : `${baseName}${extension}`;
}

export async function generateSummary(
  runtime: IAgentRuntime,
  text: string
): Promise<{ title: string; description: string }> {
  text = await trimTokens(text, 100000, runtime);

  if (!text) {
    return {
      title: "",
      description: "",
    };
  }

  if (text.length < 1000) {
    return {
      title: "",
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
 * Type guard for arrays of Discord.js components (ActionRowBuilder)
 */
function isDiscordJsComponentArray(
  components: unknown[]
): components is ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  return components.length > 0 && components.every(isDiscordJsComponent);
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
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

export async function sendMessageInChunks(
  channel: TextChannel,
  content: string,
  inReplyTo: string,
  files: Array<AttachmentBuilder | { attachment: Buffer | string; name: string }>,
  components?: DiscordActionRow[],
  runtime?: IAgentRuntime
): Promise<DiscordMessage[]> {
  const sentMessages: DiscordMessage[] = [];

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

        if (i === 0 && inReplyTo) {
          options.reply = {
            messageReference: inReplyTo,
          };
        }

        if (i === messages.length - 1 && files && files.length > 0) {
          options.files = files;
        }

        if (i === messages.length - 1 && components && components.length > 0) {
          try {
            logger.info(`Components received: ${safeStringify(components)}`);

            if (!Array.isArray(components)) {
              logger.warn("Components is not an array, skipping component processing");
            } else if (isDiscordJsComponentArray(components)) {
              options.components = components;
            } else {
              const discordComponents = (components as DiscordActionRow[])
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
          if (
            isDiscordAPIError(error) &&
            error.code === 50035 &&
            error.message &&
            error.message.includes("Unknown message")
          ) {
            logger.warn(
              "Message reference no longer valid (message may have been deleted). Sending without reply threading."
            );
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

export function needsSmartSplit(content: string): boolean {
  const codeBlockCount = (content.match(/```/g) || []).length;
  if (codeBlockCount >= 2) {
    return true;
  }

  if (/^#{1,3}\s/m.test(content)) {
    return true;
  }

  if (/^\d+\.\s/m.test(content)) {
    return true;
  }

  const lines = content.split("\n");
  const hasLongUnbreakableLines = lines.some(
    (line) => line.length > 500 && !line.includes(". ") && !line.includes(", ")
  );
  if (hasLongUnbreakableLines) {
    return true;
  }

  return false;
}

function parseJSONArrayFromText(text: string): JsonValue[] | null {
  const jsonBlockPattern = /```json\n([\s\S]*?)\n```/;
  let jsonData: JsonValue = null;
  const jsonBlockMatch = text.match(jsonBlockPattern);

  try {
    if (jsonBlockMatch) {
      jsonData = JSON.parse(jsonBlockMatch[1].trim()) as JsonValue;
    } else {
      jsonData = JSON.parse(text.trim()) as JsonValue;
    }
  } catch (_e) {
    return null;
  }

  if (Array.isArray(jsonData)) {
    return jsonData;
  }

  return null;
}

export async function smartSplitMessage(
  runtime: IAgentRuntime,
  content: string,
  maxLength: number = MAX_MESSAGE_LENGTH
): Promise<string[]> {
  if (content.length <= maxLength) {
    return [content];
  }

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

    const parsed = parseJSONArrayFromText(response);
    if (Array.isArray(parsed)) {
      const validChunks = parsed.filter(
        (chunk: unknown): chunk is string =>
          typeof chunk === "string" && chunk.trim().length > 0 && chunk.length <= maxLength
      );

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

  return splitMessage(content, maxLength);
}

export function splitMessage(content: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (!content || content.length <= maxLength) {
    return content ? [content] : [];
  }

  const messages: string[] = [];
  let currentMessage = "";

  const rawLines = content.split("\n");
  const lines = rawLines.flatMap((line) => {
    const chunks: string[] = [];
    while (line.length > maxLength) {
      let splitIdx = maxLength;
      const lastSpace = line.lastIndexOf(" ", maxLength);

      if (lastSpace > maxLength * 0.7) {
        splitIdx = lastSpace;
      } else if (lastSpace > maxLength * 0.3) {
        splitIdx = lastSpace;
      }

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

  if (messages.length === 0 && content.length > 0) {
    messages.push(" ");
  }

  return messages;
}

export interface CanSendMessageResult {
  canSend: boolean;
  reason: string | null;
  missingPermissions?: bigint[];
}

type SendableChannel = TextChannel | ThreadChannel | { type: ChannelType };

export function canSendMessage(channel: SendableChannel | null | undefined): CanSendMessageResult {
  if (!channel) {
    return {
      canSend: false,
      reason: "No channel given",
    };
  }
  if (channel.type === ChannelType.DM) {
    return {
      canSend: true,
      reason: null,
    };
  }

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

  const requiredPermissions: bigint[] = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
  ];

  if (guildChannel instanceof ThreadChannel) {
    requiredPermissions.push(PermissionsBitField.Flags.SendMessagesInThreads);
  }

  const permissions = guildChannel.permissionsFor(botMember);

  if (!permissions) {
    return {
      canSend: false,
      reason: "Could not retrieve permissions",
    };
  }

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
