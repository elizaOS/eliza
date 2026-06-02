import type { Message as DiscordMessage } from "discord.js";
import { isDiscordUserAddressed } from "./addressing";

export type DebouncerFlushCallback = (messages: DiscordMessage[]) => void;

export interface MessageDebouncer {
	enqueue: (message: DiscordMessage) => void;
	flushAll: () => void;
	pendingCount: () => number;
	destroy: () => void;
}

interface PendingEntry {
	messages: DiscordMessage[];
	timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_CHANNEL_DEBOUNCE_MS = 3_000;

function runSafely(callback: () => void): void {
	try {
		callback();
	} catch {
		// Debouncer callbacks should never crash the process.
	}
}

export interface ChannelDebouncerOptions {
	debounceMs?: number;
	responseCooldownMs?: number;
	botUserId?: string;
	getBotUserId?: () => string | undefined;
	coalesceEnabled?: boolean;
	maxBatch?: number;
	/**
	 * Only when true (strict / mention-only mode) do we carry recent unaddressed
	 * messages forward into the next addressed batch. In respond-to-all mode the
	 * agent already answers those messages on their own flush, so buffering them
	 * would prepend already-handled chatter onto a later addressed turn.
	 */
	shouldRespondOnlyToMentions?: boolean;
	/**
	 * How long a recent unaddressed message stays eligible to be folded into a
	 * following addressed message's "[Recent channel context]". Must be >= the
	 * channel debounce window so a just-flushed unaddressed message is still live
	 * when the addressed anchor lands a beat later.
	 */
	bufferTtlMs?: number;
}

export interface ChannelDebouncer {
	enqueue: (message: DiscordMessage) => void;
	markResponded: (channelId: string) => void;
	flushAll: () => void;
	pendingCount: () => number;
	destroy: () => void;
}

interface ChannelPendingEntry {
	messages: DiscordMessage[];
	timer: ReturnType<typeof setTimeout>;
}

export function createChannelDebouncer(
	onFlush: DebouncerFlushCallback,
	options: ChannelDebouncerOptions = {},
): ChannelDebouncer {
	const debounceMs = options.debounceMs ?? DEFAULT_CHANNEL_DEBOUNCE_MS;
	const responseCooldownMs = options.responseCooldownMs ?? 30_000;
	const coalesceEnabled = options.coalesceEnabled === true;
	const maxBatch = Math.max(1, options.maxBatch ?? Number.POSITIVE_INFINITY);
	const pending = new Map<string, ChannelPendingEntry>();
	const lastResponseTime = new Map<string, number>();

	// Carry recent unaddressed messages forward so a pointer-only addressed
	// message (e.g. "@bot ^^" pointing at a question typed moments earlier in a
	// separate debounce batch) still arrives with that question folded into
	// "[Recent channel context]" — matching the within-batch case the bundler
	// already handles. Buffering is recency/addressing-driven; the fold itself is
	// gated to pointer messages (see isPointerMessage) so a self-contained
	// question never has unrelated chatter prepended.
	const bufferUnaddressed =
		options.shouldRespondOnlyToMentions === true && !coalesceEnabled;
	const bufferTtlMs = Math.max(options.bufferTtlMs ?? 10_000, debounceMs);
	const recentUnaddressed = new Map<
		string,
		{ message: DiscordMessage; at: number }[]
	>();

	const pruneRecent = (channelId: string, now: number): void => {
		const buffered = recentUnaddressed.get(channelId);
		if (!buffered) {
			return;
		}
		const live = buffered.filter((entry) => now - entry.at < bufferTtlMs);
		if (live.length > 0) {
			recentUnaddressed.set(channelId, live);
		} else {
			recentUnaddressed.delete(channelId);
		}
	};

	const rememberRecent = (message: DiscordMessage): void => {
		const channelId = message.channel.id;
		const now = Date.now();
		const buffered = recentUnaddressed.get(channelId) ?? [];
		buffered.push({ message, at: now });
		recentUnaddressed.set(channelId, buffered);
		pruneRecent(channelId, now);
	};

	const drainRecent = (channelId: string): DiscordMessage[] => {
		pruneRecent(channelId, Date.now());
		const buffered = recentUnaddressed.get(channelId);
		recentUnaddressed.delete(channelId);
		return buffered ? buffered.map((entry) => entry.message) : [];
	};

	// An unaddressed message lives in BOTH the rolling buffer and (until it
	// flushes) the pending debounce batch, so a targeted message that drains both
	// can list the same message twice. Collapse by id, keeping first occurrence,
	// so "[Recent channel context]" never repeats a line.
	const dedupeById = (messages: DiscordMessage[]): DiscordMessage[] => {
		const seen = new Set<string>();
		const unique: DiscordMessage[] = [];
		for (const message of messages) {
			if (seen.has(message.id)) {
				continue;
			}
			seen.add(message.id);
			unique.push(message);
		}
		return unique;
	};

	const isBotTargeted = (message: DiscordMessage): boolean => {
		const botId = options.getBotUserId?.() ?? options.botUserId;
		return isDiscordUserAddressed({
			text: message.content,
			userId: botId,
			hasMessageReference: Boolean(message.reference?.messageId),
			repliedUserId: message.mentions?.repliedUser?.id,
		});
	};

	// A "pointer" is an addressed message that, once its mentions are removed,
	// has no word characters in any script — e.g. "@bot ^^", "@bot 👆", "@bot ?".
	// It carries no content of its own and only points at recent messages, so we
	// fold the recent-unaddressed buffer in to give the model that context.
	// A message that contains any word (a real question or instruction) stands on
	// its own and must route on its own text — folding unrelated recent chatter
	// into it can derail that routing — so we do NOT fold for those.
	const isPointerMessage = (message: DiscordMessage): boolean => {
		const withoutMentions = (message.content ?? "").replace(/<@!?\d+>/g, "");
		return !/[\p{L}\p{N}]/u.test(withoutMentions);
	};

	const isInCooldown = (channelId: string): boolean => {
		const lastRespondedAt = lastResponseTime.get(channelId);
		if (!lastRespondedAt) {
			return false;
		}
		if (Date.now() - lastRespondedAt >= responseCooldownMs) {
			lastResponseTime.delete(channelId);
			return false;
		}
		return true;
	};

	const flush = (channelId: string) => {
		const entry = pending.get(channelId);
		if (!entry) {
			return;
		}
		clearTimeout(entry.timer);
		pending.delete(channelId);
		if (entry.messages.length > 0) {
			runSafely(() => onFlush(entry.messages));
		}
	};

	const enqueue = (message: DiscordMessage) => {
		const channelId = message.channel.id;
		const targeted = isBotTargeted(message);
		if (targeted && !coalesceEnabled) {
			const buffered =
				bufferUnaddressed && isPointerMessage(message)
					? drainRecent(channelId)
					: [];
			const entry = pending.get(channelId);
			if (entry) {
				clearTimeout(entry.timer);
				pending.delete(channelId);
				entry.messages.push(message);
				runSafely(() => onFlush(dedupeById([...buffered, ...entry.messages])));
			} else {
				runSafely(() =>
					onFlush(buffered.length > 0 ? [...buffered, message] : [message]),
				);
			}
			return;
		}

		// The response cooldown throttles further REPLIES after the bot answers.
		// When we buffer unaddressed messages (strict / mention-only mode) those
		// messages never trigger a reply anyway, so dropping them here would only
		// discard context the next "@bot ^^" pointer needs. Keep ingesting +
		// buffering them; the cooldown still gates unaddressed traffic in
		// respond-to-all mode (bufferUnaddressed is false there).
		if (isInCooldown(channelId) && !targeted && !bufferUnaddressed) {
			return;
		}

		if (bufferUnaddressed && !targeted) {
			rememberRecent(message);
		}

		if (debounceMs <= 0) {
			runSafely(() => onFlush([message]));
			return;
		}

		const existing = pending.get(channelId);
		if (existing) {
			clearTimeout(existing.timer);
			existing.messages.push(message);
			if (coalesceEnabled && existing.messages.length >= maxBatch) {
				flush(channelId);
				return;
			}
			existing.timer = setTimeout(() => flush(channelId), debounceMs);
			return;
		}

		pending.set(channelId, {
			messages: [message],
			timer: setTimeout(() => flush(channelId), debounceMs),
		});
	};

	return {
		enqueue,
		markResponded: (channelId: string) => {
			lastResponseTime.set(channelId, Date.now());
			// Buffered chatter has now been answered (or folded into the reply);
			// drop it so it never re-bundles into a later unrelated response.
			recentUnaddressed.delete(channelId);
		},
		flushAll: () => {
			for (const key of [...pending.keys()]) {
				flush(key);
			}
		},
		pendingCount: () => pending.size,
		destroy: () => {
			for (const [, entry] of pending) {
				clearTimeout(entry.timer);
			}
			pending.clear();
			lastResponseTime.clear();
			recentUnaddressed.clear();
		},
	};
}

export function createMessageDebouncer(
	onFlush: DebouncerFlushCallback,
	debounceMs: number = DEFAULT_DEBOUNCE_MS,
	options: { maxBatch?: number } = {},
): MessageDebouncer {
	const pending = new Map<string, PendingEntry>();
	const maxBatch = Math.max(1, options.maxBatch ?? Number.POSITIVE_INFINITY);

	const makeKey = (message: DiscordMessage) =>
		`${message.channel.id}:${message.author.id}`;

	const flush = (key: string) => {
		const entry = pending.get(key);
		if (!entry) {
			return;
		}
		clearTimeout(entry.timer);
		pending.delete(key);
		if (entry.messages.length > 0) {
			runSafely(() => onFlush(entry.messages));
		}
	};

	const hasMedia = (message: DiscordMessage) =>
		(message.attachments?.size ?? 0) > 0 || (message.stickers?.size ?? 0) > 0;

	const enqueue = (message: DiscordMessage) => {
		if (debounceMs <= 0) {
			runSafely(() => onFlush([message]));
			return;
		}

		const key = makeKey(message);
		if (hasMedia(message)) {
			const entry = pending.get(key);
			if (entry) {
				clearTimeout(entry.timer);
				pending.delete(key);
				if (entry.messages.length > 0) {
					runSafely(() => onFlush(entry.messages));
				}
			}
			runSafely(() => onFlush([message]));
			return;
		}

		const existing = pending.get(key);
		if (existing) {
			clearTimeout(existing.timer);
			existing.messages.push(message);
			if (existing.messages.length >= maxBatch) {
				flush(key);
				return;
			}
			existing.timer = setTimeout(() => flush(key), debounceMs);
			return;
		}

		pending.set(key, {
			messages: [message],
			timer: setTimeout(() => flush(key), debounceMs),
		});
	};

	return {
		enqueue,
		flushAll: () => {
			for (const key of [...pending.keys()]) {
				flush(key);
			}
		},
		pendingCount: () => pending.size,
		destroy: () => {
			for (const [, entry] of pending) {
				clearTimeout(entry.timer);
			}
			pending.clear();
		},
	};
}
