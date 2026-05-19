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

	const isBotTargeted = (message: DiscordMessage): boolean => {
		const botId = options.getBotUserId?.() ?? options.botUserId;
		return isDiscordUserAddressed({
			text: message.content,
			userId: botId,
			hasMessageReference: Boolean(message.reference?.messageId),
			repliedUserId: message.mentions?.repliedUser?.id,
		});
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
			const entry = pending.get(channelId);
			if (entry) {
				clearTimeout(entry.timer);
				pending.delete(channelId);
				entry.messages.push(message);
				runSafely(() => onFlush(entry.messages));
			} else {
				runSafely(() => onFlush([message]));
			}
			return;
		}

		if (isInCooldown(channelId) && !targeted) {
			return;
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
