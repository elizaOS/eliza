/**
 * Decides which managed Discord guild messages reach an Eliza runtime. The
 * gateway excludes turns explicitly aimed only at someone else, while leaving
 * ambient conversation to the runtime's contextual respond-or-ignore gate.
 */

export type ManagedGuildInvocation = "mention" | "reply" | "ambient";

export interface ManagedGuildMessageInput {
  botUserId: string;
  content: string;
  mentionedUserIds: readonly string[];
  repliedUserId?: string | null;
  mentionsEveryone?: boolean;
}

export interface ManagedGuildMessageTurn {
  content: string;
  invocation: ManagedGuildInvocation;
}

/**
 * Returns the transport-clean turn to route, or `null` when Discord facts prove
 * the message belongs only to another participant (or contains no usable text).
 */
export function managedGuildMessageTurn(
  input: ManagedGuildMessageInput,
): ManagedGuildMessageTurn | null {
  const trimmedContent = input.content.trim();
  if (!trimmedContent || !input.botUserId) return null;

  const escapedBotUserId = input.botUserId.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const botMentionRegex = new RegExp(`<@!?${escapedBotUserId}>`, "g");
  const botMentioned =
    input.mentionedUserIds.includes(input.botUserId) ||
    botMentionRegex.test(trimmedContent);
  const repliedToBot = input.repliedUserId === input.botUserId;
  const targetsOtherParticipant =
    input.mentionedUserIds.some((userId) => userId !== input.botUserId) ||
    Boolean(input.mentionsEveryone) ||
    Boolean(input.repliedUserId && !repliedToBot);

  // A deliberate call to Eliza wins over a co-mention: role calls commonly
  // name several agents at once, and each named agent should receive the turn.
  if (!botMentioned && !repliedToBot && targetsOtherParticipant) return null;

  const content = trimmedContent.replace(botMentionRegex, "").trim();
  if (!content) return null;

  return {
    content,
    invocation: botMentioned ? "mention" : repliedToBot ? "reply" : "ambient",
  };
}
