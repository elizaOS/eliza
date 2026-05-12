import type { Message as DiscordMessage } from "discord.js";
import { isDiscordUserAddressed } from "./addressing";

export type StatusReactionScope = "all" | "group-mentions" | "none";

export interface StatusReactionController {
	setQueued: () => void;
	setThinking: () => void;
	setDone: () => void;
	setError: () => void;
}

const EMOJI_QUEUED = "⏳";
const EMOJI_THINKING = "🤔";
const EMOJI_DONE = "✅";
const EMOJI_ERROR = "❌";

export function shouldShowStatusReaction(
	scope: StatusReactionScope,
	message: DiscordMessage,
	botId: string | undefined,
): boolean {
	if (scope === "none") {
		return false;
	}
	if (scope === "all") {
		return true;
	}

	if (!message.guild) {
		return true;
	}

	return isDiscordUserAddressed({
		text: message.content,
		userId: botId,
		hasMessageReference: Boolean(message.reference?.messageId),
		repliedUserId: message.mentions.repliedUser?.id,
	});
}

export function createStatusReactionController(
	message: DiscordMessage,
): StatusReactionController {
	let currentEmoji: string | null = null;
	let finished = false;
	let chain: Promise<void> = Promise.resolve();
	const botId = message.client?.user?.id;

	const transition = (emoji: string, terminal = false) => {
		if (finished) {
			return;
		}
		chain = chain.then(async () => {
			if (finished && !terminal) {
				return;
			}

			try {
				if (currentEmoji && currentEmoji !== emoji && botId) {
					try {
						const reaction = message.reactions.resolve(currentEmoji);
						if (reaction) {
							await reaction.users.remove(botId);
						}
					} catch {
						// Ignore missing permissions or already-removed reactions.
					}
				}

				await message.react(emoji);
				currentEmoji = emoji;
			} catch {
				// Reaction failures are non-critical.
			} finally {
				if (terminal) {
					finished = true;
				}
			}
		});
	};

	return {
		setQueued: () => transition(EMOJI_QUEUED),
		setThinking: () => transition(EMOJI_THINKING),
		setDone: () => transition(EMOJI_DONE, true),
		setError: () => transition(EMOJI_ERROR, true),
	};
}
