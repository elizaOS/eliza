/**
 * Status-reaction scope logic — decides whether an inbound message is
 * acknowledged with a processing emoji (queued / thinking / done / error)
 * based on the configured scope and whether the bot was addressed.
 */
import type { Message as DiscordMessage } from "discord.js";
import { isDiscordUserAddressed } from "./addressing";

export type StatusReactionScope = "all" | "group-mentions" | "none";

export interface StatusReactionController {
	setQueued: () => void;
	setThinking: () => void;
	setDone: () => void;
	setError: () => void;
	/**
	 * Force this controller to its terminal state from outside the normal
	 * turn lifecycle. Used by the connector's shutdown drain path when a
	 * turn is abandoned before it finished on its own, so no reaction is
	 * left showing "in progress" forever. Idempotent: a no-op once the
	 * controller already reached a terminal state (including a prior
	 * `abandon()`).
	 */
	abandon: () => void;
	/** Resolves once this controller reaches any terminal state. */
	whenFinished: Promise<void>;
}

const EMOJI_QUEUED = "⏳";
const EMOJI_THINKING = "🤔";
const EMOJI_ERROR = "❌";

/**
 * The non-terminal markers a turn shows while it is still being processed.
 * A bot-authored reaction from this set that survives a process death is
 * unambiguous crash residue: every live path either advances it (`transition`
 * removes the previous emoji), clears it (`setDone`), or replaces it with the
 * terminal ❌ (`setError` / `abandon`). The startup reconcile scan removes
 * exactly this set and must never touch ❌, which is deliberate terminal
 * state. Exported so the scan cannot drift from the controller's emojis.
 */
export const IN_PROGRESS_STATUS_EMOJIS: readonly string[] = [
	EMOJI_QUEUED,
	EMOJI_THINKING,
];

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
	let resolveFinished: () => void = () => {};
	const whenFinished = new Promise<void>((resolve) => {
		resolveFinished = resolve;
	});
	const botId = message.client?.user?.id;

	const clearCurrentReaction = async () => {
		if (!currentEmoji || !botId) {
			return;
		}
		try {
			const reaction = message.reactions.resolve(currentEmoji);
			if (reaction) {
				await reaction.users.remove(botId);
			}
		} catch {
			// Ignore missing permissions or already-removed reactions.
		}
		currentEmoji = null;
	};

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
					resolveFinished();
				}
			}
		});
	};

	const finishWithoutSuccessReaction = () => {
		if (finished) {
			return;
		}
		chain = chain.then(async () => {
			await clearCurrentReaction();
			finished = true;
			resolveFinished();
		});
	};

	return {
		setQueued: () => transition(EMOJI_QUEUED),
		setThinking: () => transition(EMOJI_THINKING),
		setDone: () => finishWithoutSuccessReaction(),
		setError: () => transition(EMOJI_ERROR, true),
		// Same terminal error-reaction transition as setError: a turn the
		// shutdown drain had to abandon mid-flight did not complete
		// successfully, so it gets the same visible marker rather than
		// silently vanishing or being left on its last in-progress emoji.
		abandon: () => transition(EMOJI_ERROR, true),
		whenFinished,
	};
}
