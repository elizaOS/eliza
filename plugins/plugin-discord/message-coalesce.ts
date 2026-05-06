import type { Message as DiscordMessage } from "discord.js";

export interface DiscordMessageCoalesceConfig {
	enabled: boolean;
	windowMs: number;
	maxBatch: number;
}

export interface CoalescedDiscordMessageMeta {
	id?: string;
	channelId?: string;
	authorId?: string;
	username?: string;
	displayName?: string;
	createdTimestamp?: number;
	contentPreview: string;
}

export type DiscordMessageWithCoalescedMetadata = DiscordMessage & {
	__discordCoalescedMessages?: CoalescedDiscordMessageMeta[];
	__discordCoalescedMessageIds?: string[];
};

const DEFAULT_WINDOW_MS = 8_000;
const DEFAULT_MAX_BATCH = 5;

function parseBoolean(value: unknown, fallback: boolean): boolean {
	if (value === undefined || value === null) {
		return fallback;
	}
	return String(value).trim().toLowerCase() === "true";
}

function parsePositiveInteger(value: unknown, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getDiscordMessageCoalesceConfig(
	getSetting: (key: string) => unknown,
): DiscordMessageCoalesceConfig {
	const enabled = parseBoolean(
		getSetting("DISCORD_MESSAGE_COALESCE_ENABLED"),
		false,
	);

	return {
		enabled,
		windowMs: enabled
			? parsePositiveInteger(
					getSetting("DISCORD_MESSAGE_COALESCE_WINDOW_MS"),
					DEFAULT_WINDOW_MS,
				)
			: DEFAULT_WINDOW_MS,
		maxBatch: parsePositiveInteger(
			getSetting("DISCORD_MESSAGE_COALESCE_MAX_BATCH"),
			DEFAULT_MAX_BATCH,
		),
	};
}

export function getDiscordMessageMeta(
	message: DiscordMessage,
): CoalescedDiscordMessageMeta {
	return {
		id: message.id,
		channelId: message.channel?.id,
		authorId: message.author?.id,
		username: message.author?.username,
		displayName:
			message.member?.displayName ??
			message.author?.globalName ??
			message.author?.displayName ??
			message.author?.username,
		createdTimestamp: message.createdTimestamp,
		contentPreview: String(message.content || "").slice(0, 300),
	};
}

export function formatCoalescedDiscordMessages(
	messages: DiscordMessage[],
): string {
	return messages
		.map((message, index) => {
			const meta = getDiscordMessageMeta(message);
			const label =
				meta.displayName || meta.username || meta.authorId || "unknown";
			const ordinal = index + 1;
			return `[Discord message ${ordinal}/${messages.length} id=${meta.id || "unknown"} author=${label} author_id=${meta.authorId || "unknown"} at=${meta.createdTimestamp || "unknown"}]\n${message.content || ""}\n[/Discord message ${ordinal}/${messages.length} id=${meta.id || "unknown"}]`;
		})
		.join("\n\n");
}

export function makeCoalescedDiscordMessage(
	messages: DiscordMessage[],
	anchor?: DiscordMessage,
	config: Pick<DiscordMessageCoalesceConfig, "enabled" | "maxBatch"> = {
		enabled: false,
		maxBatch: DEFAULT_MAX_BATCH,
	},
): DiscordMessage {
	if (!config.enabled || messages.length <= 1) {
		return anchor ?? messages[0];
	}

	const capped = messages.slice(0, config.maxBatch);
	const base = anchor ?? capped[capped.length - 1] ?? messages[0];
	const meta = capped.map(getDiscordMessageMeta);
	return Object.create(base, {
		content: {
			value: formatCoalescedDiscordMessages(capped),
			writable: true,
			enumerable: true,
			configurable: true,
		},
		__discordCoalescedMessages: {
			value: meta,
			writable: false,
			enumerable: false,
			configurable: true,
		},
		__discordCoalescedMessageIds: {
			value: meta.map((entry) => entry.id).filter(Boolean),
			writable: false,
			enumerable: false,
			configurable: true,
		},
	});
}

export function appendCoalescedDiscordMetadata(
	message: DiscordMessage,
	extraMetadata: Record<string, unknown> = {},
): any {
	const coalesced = message as DiscordMessageWithCoalescedMetadata;
	const ids = coalesced.__discordCoalescedMessageIds;
	const messages = coalesced.__discordCoalescedMessages;
	if (!Array.isArray(ids) || ids.length <= 1) {
		return extraMetadata;
	}

	return {
		...extraMetadata,
		coalescedDiscordMessageIds: ids,
		coalescedDiscordMessages: Array.isArray(messages) ? messages : undefined,
		coalescedDiscordMessageCount: ids.length,
	};
}
