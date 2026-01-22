import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { Message, TextChannel } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import { reactToMessageTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";

/**
 * Extracts emoji tokens from a string in the order they appear.
 *
 * Captures standard Unicode emoji sequences (including multi-codepoint sequences joined by zero-width joiners) and Discord custom emoji tokens in the form `<:name:id>` or `<a:name:id>`.
 *
 * @param text - The input text to scan for emojis
 * @returns An array of emoji strings found in `text`, in the order they appear (empty if none)
 */
function extractEmojisFromText(text: string): string[] {
  if (!text) {
    return [];
  }

  // Collect all emoji matches with their positions to preserve order
  const matches: { index: number; emoji: string }[] = [];

  // Match Unicode emojis (including multi-codepoint sequences)
  const unicodeEmojiRegex =
    /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:\uFE0F)?(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:\uFE0F)?)*/gu;
  let match: RegExpExecArray | null = null;
  match = unicodeEmojiRegex.exec(text);
  while (match !== null) {
    matches.push({ index: match.index, emoji: match[0] });
    match = unicodeEmojiRegex.exec(text);
  }

  // Match Discord custom emojis <:name:id> or <a:name:id>
  const customEmojiRegex = /<a?:\w+:\d+>/g;
  match = customEmojiRegex.exec(text);
  while (match !== null) {
    matches.push({ index: match.index, emoji: match[0] });
    match = customEmojiRegex.exec(text);
  }

  // Sort by position and return just the emojis
  return matches.sort((a, b) => a.index - b.index).map((m) => m.emoji);
}

/**
 * Determines whether a message explicitly requests adding a reaction or specifies a target.
 *
 * @param text - The message text to inspect for reaction-related keywords or target patterns
 * @returns `true` if the text contains reaction keywords OR specifies a message target; `false` otherwise.
 */
function isExplicitReactionRequest(text: string): boolean {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();

  // Keywords indicating user explicitly requested a reaction
  if (/\b(react|reaction|emoji)\b/.test(lower)) {
    return true;
  }

  // Patterns indicating a specific message target (e.g., "add thumbs up to john's message")
  // These require LLM to extract the correct messageRef
  if (/\w+'s\s+message\b/.test(lower)) {
    return true;
  } // "john's message"
  if (/message\s+(about|from|where)\b/.test(lower)) {
    return true;
  } // "message about X"
  if (/\bto\s+\w+'s\b/.test(lower)) {
    return true;
  } // "to john's"
  if (/\bthat\s+message\b/.test(lower)) {
    return true;
  } // "that message"

  return false;
}

// Common Discord emoji mappings
const emojiMap: Record<string, string> = {
  ":thumbsup:": "👍",
  ":thumbs_up:": "👍",
  ":+1:": "👍",
  ":thumbsdown:": "👎",
  ":thumbs_down:": "👎",
  ":-1:": "👎",
  ":heart:": "❤️",
  ":fire:": "🔥",
  ":star:": "⭐",
  ":check:": "✅",
  ":white_check_mark:": "✅",
  ":x:": "❌",
  ":cross:": "❌",
  ":smile:": "😄",
  ":laughing:": "😆",
  ":thinking:": "🤔",
  ":eyes:": "👀",
  ":clap:": "👏",
  ":wave:": "👋",
  ":ok:": "👌",
  ":ok_hand:": "👌",
  ":raised_hands:": "🙌",
  ":pray:": "🙏",
  ":100:": "💯",
  ":rocket:": "🚀",
};

const spec = requireActionSpec("REACT_TO_MESSAGE");

export const reactToMessage: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return message.content.source === "discord";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const discordService = runtime.getService(DISCORD_SERVICE_NAME) as DiscordService;

    if (!discordService || !discordService.client) {
      await callback?.({
        text: "Discord service is not available.",
        source: "discord",
      });
      return;
    }

    // ============================================================================
    // Extract reaction info - use fast path when appropriate, LLM otherwise
    // ============================================================================
    let reactionInfo: { messageRef: string; emoji: string } | null = null;

    // Check if user explicitly requested a reaction (needs LLM for accuracy)
    // vs agent spontaneously reacting (fast path to "last message" is correct)
    const messageContent = message.content;
    const userText = messageContent?.text || "";
    const needsLLM = isExplicitReactionRequest(userText);

    if (!needsLLM) {
      // FAST PATH: Agent spontaneously reacting - target is always "last message"
      const stateData = state.data as Record<string, unknown> | undefined;
      const stateWithResponseText = state as State & { responseText?: string };
      const responseText = String(
        stateData?.responseText || stateData?.text || stateWithResponseText.responseText || ""
      );

      if (responseText) {
        const emojis = extractEmojisFromText(responseText);
        if (emojis.length > 0) {
          runtime.logger.debug(
            {
              src: "plugin:discord:action:react",
              emoji: emojis[0],
              source: "responseText",
            },
            "[REACT_TO_MESSAGE] Found emoji in response text (fast path)"
          );
          reactionInfo = { messageRef: "last", emoji: emojis[0] };
        }
      }

      if (!reactionInfo) {
        // Check recent messages for this agent's last message
        const stateData = state.data;
        const recentMessages = (stateData?.recentMessages || []) as Memory[];
        const agentLastMessage = recentMessages.filter((m) => m.entityId === runtime.agentId).pop();

        const agentLastMessageContent = agentLastMessage?.content;
        if (agentLastMessageContent?.text) {
          const emojis = extractEmojisFromText(agentLastMessageContent.text);
          if (emojis.length > 0) {
            runtime.logger.debug(
              {
                src: "plugin:discord:action:react",
                emoji: emojis[0],
                source: "agentLastMessage",
              },
              "[REACT_TO_MESSAGE] Found emoji in agent's last message (fast path)"
            );
            reactionInfo = { messageRef: "last", emoji: emojis[0] };
          }
        }
      }
    }

    if (!reactionInfo) {
      // LLM PATH: Use when fast path fails or user specified a specific target
      const prompt = composePromptFromState({
        state,
        template: reactToMessageTemplate,
      });

      for (let i = 0; i < 3; i++) {
        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        });

        const parsedResponse = parseJSONObjectFromText(response);
        if (parsedResponse?.emoji) {
          reactionInfo = {
            messageRef: String(parsedResponse.messageRef || "last"),
            emoji: String(parsedResponse.emoji),
          };
          break;
        }
      }
    }

    if (!reactionInfo) {
      runtime.logger.debug(
        { src: "plugin:discord:action:react" },
        "[REACT_TO_MESSAGE] Could not extract reaction info"
      );
      // Only show error to user if they explicitly requested a reaction
      // Silent failure is appropriate when agent spontaneously decides to react
      if (needsLLM) {
        await callback?.({
          text: "I couldn't understand which message to react to or what emoji to use. Try being more specific, like 'react with 👍 to the last message'.",
          source: "discord",
        });
      }
      return;
    }

    try {
      const stateData = state.data;
      const room = stateData?.room || (await runtime.getRoom(message.roomId));
      if (!room || !room.channelId) {
        await callback?.({
          text: "I couldn't determine the current channel.",
          source: "discord",
        });
        return;
      }

      const channel = await discordService.client.channels.fetch(room.channelId);
      if (!channel || !channel.isTextBased()) {
        await callback?.({
          text: "I can only react to messages in text channels.",
          source: "discord",
        });
        return;
      }

      const textChannel = channel as TextChannel;

      let targetMessage: Message | null = null;

      // Find the target message
      if (reactionInfo.messageRef === "last" || reactionInfo.messageRef === "previous") {
        // Get the last few messages - fetch max allowed by Discord API
        const messages = await textChannel.messages.fetch({ limit: 100 });
        const sortedMessages = Array.from(messages.values()).sort(
          (a, b) => b.createdTimestamp - a.createdTimestamp
        );

        // Skip the bot's own message and the command message
        const clientUser = discordService.client.user;
        targetMessage =
          sortedMessages.find(
            (msg) => msg.id !== message.content.id && msg.author.id !== clientUser?.id
          ) || null;
      } else if (/^\d+$/.test(reactionInfo.messageRef)) {
        // It's a message ID
        try {
          targetMessage = await textChannel.messages.fetch(reactionInfo.messageRef);
        } catch (_e) {
          // Message not found
        }
      } else {
        // Search for message by content/author - fetch max allowed by Discord API
        const messages = await textChannel.messages.fetch({ limit: 100 });
        const searchLower = reactionInfo.messageRef.toLowerCase();

        targetMessage =
          Array.from(messages.values()).find((msg) => {
            const contentMatch = msg.content.toLowerCase().includes(searchLower);
            const authorMatch = msg.author.username.toLowerCase().includes(searchLower);
            return contentMatch || authorMatch;
          }) || null;
      }

      if (!targetMessage) {
        await callback?.({
          text: "I couldn't find the message you want me to react to. Try being more specific or use 'last message'.",
          source: "discord",
        });
        return;
      }

      // Normalize the emoji
      let emoji = reactionInfo.emoji;
      if (!/\p{Emoji}/u.test(emoji)) {
        const mapped = emojiMap[emoji.toLowerCase()];
        if (mapped) {
          emoji = mapped;
        } else if (!/<a?:\w+:\d+>/.test(emoji)) {
          // Not a custom emoji, remove colons
          emoji = emoji.replace(/:/g, "");
        }
      }

      // Add the reaction
      try {
        await targetMessage.react(emoji);

        const response: Content = {
          text: `I've added a ${emoji} reaction to the message.`,
          source: message.content.source,
        };

        await callback?.(response);
      } catch (error) {
        runtime.logger.error(
          {
            src: "plugin:discord:action:react-to-message",
            agentId: runtime.agentId,
            emoji: reactionInfo.emoji,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to add reaction"
        );
        await callback?.({
          text: `I couldn't add that reaction. Make sure the emoji "${reactionInfo.emoji}" is valid and I have permission to add reactions.`,
          source: "discord",
        });
      }
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:react-to-message",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error in react to message"
      );
      await callback?.({
        text: "I encountered an error while trying to react to the message. Please make sure I have the necessary permissions.",
        source: "discord",
      });
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default reactToMessage;
