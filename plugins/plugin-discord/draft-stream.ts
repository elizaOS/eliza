/**
 * Streams an in-progress agent reply to Discord by editing a single message as
 * draft chunks arrive, using the draft-chunking break logic.
 */
import { truncateWellFormed } from "@elizaos/core";
import type {
	ActionRowBuilder,
	Message as DiscordMessage,
	MessageActionRowComponentBuilder,
	TextChannel,
} from "discord.js";
import { chunkDiscordText } from "./messaging";

type DraftReplyToMode = "off" | "first" | "all";

export interface DraftStreamOptions {
	throttleMs?: number;
	minInitialChars?: number;
	maxChars?: number;
	log?: (msg: string) => void;
	warn?: (msg: string) => void;
}

export interface DraftStreamController {
	start: (
		channel: TextChannel,
		replyToMessageId?: string,
		replyToMode?: DraftReplyToMode,
	) => Promise<DiscordMessage | null>;
	update: (text: string) => void;
	/**
	 * Sends the final reply. A send that Discord refuses stops the remaining
	 * parts and is passed to `onSendFailure`; the returned messages are the
	 * parts that were delivered.
	 */
	finalize: (
		text: string,
		components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
		onSendFailure?: (error: unknown) => void,
	) => Promise<DiscordMessage[]>;
	abort: (reason?: string) => Promise<void>;
	/** End streaming without emitting an interruption message. */
	discard: () => Promise<void>;
	messageId: () => string | undefined;
	isStarted: () => boolean;
	isDone: () => boolean;
}

const DEFAULT_THROTTLE_MS = 1_200;
const DEFAULT_MIN_INITIAL_CHARS = 40;
const DISCORD_MAX_CHARS = 2_000;

export function createDraftStreamController(
	options: DraftStreamOptions = {},
): DraftStreamController {
	const throttleMs = Math.max(250, options.throttleMs ?? DEFAULT_THROTTLE_MS);
	const minInitialChars = options.minInitialChars ?? DEFAULT_MIN_INITIAL_CHARS;
	const maxChars = Math.min(
		options.maxChars ?? DISCORD_MAX_CHARS,
		DISCORD_MAX_CHARS,
	);
	const log = options.log ?? (() => {});
	const warn = options.warn ?? (() => {});

	let channel: TextChannel | null = null;
	let draftReplyToMessageId: string | undefined;
	let draftReplyToMode: DraftReplyToMode = "first";
	let lastSentText = "";
	let lastSentMessage: DiscordMessage | null = null;
	const sentMessages: DiscordMessage[] = [];
	let pendingText: string | null = null;
	let throttleTimer: ReturnType<typeof setTimeout> | null = null;
	let started = false;
	let done = false;
	const activeSnapshots = new Set<Promise<unknown>>();
	// The error of the last refused snapshot send, read by finalize.
	let lastSendError: unknown;

	const clearThrottle = () => {
		if (throttleTimer) {
			clearTimeout(throttleTimer);
			throttleTimer = null;
		}
	};

	const sendSnapshot = async (
		text: string,
		components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
	): Promise<boolean> => {
		if (done || !channel) {
			return false;
		}

		const trimmed = text.trimEnd();
		if (!trimmed) {
			return false;
		}

		const displayText =
			trimmed.length > maxChars
				? maxChars > 3
					? `${truncateWellFormed(trimmed, maxChars - 3)}...`
					: truncateWellFormed(trimmed, maxChars)
				: trimmed;
		if (displayText === lastSentText) {
			if (components && components.length > 0 && lastSentMessage) {
				try {
					const edited = await lastSentMessage.edit({
						content: displayText,
						components,
					});
					lastSentMessage = edited;
					const lastIndex = sentMessages.length - 1;
					if (lastIndex >= 0) {
						sentMessages[lastIndex] = edited;
					}
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					warn(`draft-stream: final component edit failed: ${errorMessage}`);
					try {
						const sent = await channel.send({
							content: displayText,
							components,
							...(draftReplyToMessageId && draftReplyToMode !== "off"
								? {
										reply: { messageReference: draftReplyToMessageId },
									}
								: {}),
						});
						lastSentMessage = sent;
						sentMessages.push(sent);
					} catch (sendError) {
						const sendErrorMessage =
							sendError instanceof Error
								? sendError.message
								: String(sendError);
						warn(
							`draft-stream: final component resend failed: ${sendErrorMessage}`,
						);
						lastSendError = sendError;
						return false;
					}
				}
			}
			return true;
		}

		try {
			const sent = await channel.send({
				content: displayText,
				...(components && components.length > 0 ? { components } : {}),
				...(draftReplyToMessageId && draftReplyToMode !== "off"
					? {
							reply: { messageReference: draftReplyToMessageId },
						}
					: {}),
			});
			lastSentMessage = sent;
			sentMessages.push(sent);
			lastSentText = displayText;
			return true;
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			warn(`draft-stream: send failed: ${errorMessage}`);
			lastSendError = error;
			return false;
		}
	};

	const trackActiveSnapshot = <T>(snapshot: Promise<T>): Promise<T> => {
		activeSnapshots.add(snapshot);
		void snapshot.then(
			() => activeSnapshots.delete(snapshot),
			() => activeSnapshots.delete(snapshot),
		);
		return snapshot;
	};

	const sendTrackedSnapshot = (
		text: string,
		components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
	): Promise<boolean> => {
		return trackActiveSnapshot(sendSnapshot(text, components));
	};

	const waitForActiveSnapshots = async (): Promise<void> => {
		while (activeSnapshots.size > 0) {
			await Promise.allSettled([...activeSnapshots]);
		}
	};

	const flush = async (): Promise<void> => {
		clearThrottle();
		if (pendingText !== null) {
			const text = pendingText;
			pendingText = null;
			await sendTrackedSnapshot(text);
		}
	};

	const scheduleUpdate = (text: string) => {
		pendingText = text;
		if (!throttleTimer) {
			throttleTimer = setTimeout(async () => {
				throttleTimer = null;
				await flush();
			}, throttleMs);
		}
	};

	const start = async (
		nextChannel: TextChannel,
		replyToMessageId?: string,
		replyToMode: DraftReplyToMode = "first",
	): Promise<DiscordMessage | null> => {
		if (started) {
			warn("draft-stream: start() called twice, ignoring");
			return lastSentMessage;
		}
		started = true;
		channel = nextChannel;
		draftReplyToMessageId = replyToMessageId;
		draftReplyToMode = replyToMode;

		log(`draft-stream: started (append-only, throttle=${throttleMs}ms)`);
		return null;
	};

	const update = (text: string) => {
		if (done || !started) {
			return;
		}
		if (!lastSentMessage && text.length < minInitialChars) {
			return;
		}
		scheduleUpdate(text);
	};

	const finalize = async (
		text: string,
		components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
		onSendFailure?: (error: unknown) => void,
	): Promise<DiscordMessage[]> => {
		if (done) {
			return sentMessages;
		}

		clearThrottle();
		pendingText = null;

		if (!started) {
			warn("draft-stream: finalize called before start");
			done = true;
			return [];
		}

		const trimmed = text.trimEnd();
		if (!trimmed) {
			done = true;
			return [];
		}

		// Fence-aware: a code block cut between messages is closed and reopened.
		const chunks =
			trimmed.length <= maxChars
				? [trimmed]
				: chunkDiscordText(trimmed, {
						maxChars,
						maxLines: Number.POSITIVE_INFINITY,
					});
		const [firstChunk, ...overflow] = chunks;
		lastSendError = undefined;
		const firstSent = await sendTrackedSnapshot(
			firstChunk ?? "",
			overflow.length === 0 ? components : undefined,
		);
		if (done) {
			return sentMessages;
		}
		if (!firstSent && lastSendError !== undefined) {
			// The rest of the reply would arrive without its start.
			done = true;
			onSendFailure?.(lastSendError);
			return sentMessages;
		}

		for (const [index, chunk] of overflow.entries()) {
			if (done || !channel) {
				break;
			}
			const isLastChunk = index === overflow.length - 1;
			try {
				await trackActiveSnapshot(
					channel
						.send({
							content: chunk,
							...(isLastChunk && components && components.length > 0
								? { components }
								: {}),
							...(draftReplyToMessageId && draftReplyToMode === "all"
								? {
										reply: { messageReference: draftReplyToMessageId },
									}
								: {}),
						})
						.then((overflowMessage) => {
							lastSentMessage = overflowMessage;
							sentMessages.push(overflowMessage);
						}),
				);
			} catch (error) {
				warn(
					`draft-stream: overflow send failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				onSendFailure?.(error);
				break;
			}
		}

		done = true;
		log(
			chunks.length === 1
				? "draft-stream: finalized (single message)"
				: "draft-stream: finalized (multi-message)",
		);
		return sentMessages;
	};

	const abort = async (reason?: string): Promise<void> => {
		if (done) {
			return;
		}
		done = true;
		clearThrottle();
		pendingText = null;

		if (!channel) {
			return;
		}

		const errorText = reason
			? `⚠️ ${reason}`
			: "⚠️ Response generation was interrupted.";
		try {
			await channel.send({ content: errorText });
		} catch (error) {
			warn(
				`draft-stream: abort send failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		log("draft-stream: aborted");
	};

	const discard = async (): Promise<void> => {
		if (done) {
			return;
		}
		done = true;
		clearThrottle();
		pendingText = null;
		await waitForActiveSnapshots();
		for (const message of [...sentMessages].reverse()) {
			try {
				await message.delete();
			} catch (error) {
				// error-policy:J6 designed-abort teardown is best-effort; failure to
				// delete an already-sent snapshot is observable in connector logs.
				warn(
					`draft-stream: silent discard delete failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		log("draft-stream: discarded silently");
	};

	return {
		start,
		update,
		finalize,
		abort,
		discard,
		messageId: () => lastSentMessage?.id,
		isStarted: () => started,
		isDone: () => done,
	};
}
