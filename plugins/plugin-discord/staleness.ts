import type { Content } from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";

export type DiscordStalenessBehavior = "tag" | "skip" | "ignore";

export interface DiscordStalenessConfig {
	enabled: boolean;
	behavior: DiscordStalenessBehavior;
	threshold: number;
}

const DEFAULT_THRESHOLD = 2;
const channelSequences = new WeakMap<object, Map<string, number>>();
const lastMessageIds = new WeakMap<object, Map<string, string | undefined>>();

function parseBoolean(value: unknown, fallback: boolean): boolean {
	if (value === undefined || value === null) {
		return fallback;
	}
	return String(value).trim().toLowerCase() === "true";
}

function parseNonNegativeInteger(value: unknown, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBehavior(value: unknown): DiscordStalenessBehavior {
	const normalized = String(value ?? "tag")
		.trim()
		.toLowerCase();
	return normalized === "skip" ||
		normalized === "ignore" ||
		normalized === "tag"
		? normalized
		: "tag";
}

function ensureSequenceMap(owner: object): Map<string, number> {
	let map = channelSequences.get(owner);
	if (!map) {
		map = new Map<string, number>();
		channelSequences.set(owner, map);
	}
	return map;
}

export function getDiscordStalenessConfig(
	getSetting: (key: string) => unknown,
): DiscordStalenessConfig {
	return {
		enabled: parseBoolean(getSetting("DISCORD_STALENESS_ENABLED"), false),
		behavior: parseBehavior(getSetting("DISCORD_STALENESS_BEHAVIOR")),
		threshold: parseNonNegativeInteger(
			getSetting("DISCORD_STALENESS_THRESHOLD"),
			DEFAULT_THRESHOLD,
		),
	};
}

export function recordDiscordChannelMessageSeen(
	owner: object | undefined,
	channelId: string | undefined,
	messageId?: string,
): number {
	if (!owner || !channelId) {
		return 0;
	}
	const sequences = ensureSequenceMap(owner);
	const next = (sequences.get(channelId) ?? 0) + 1;
	sequences.set(channelId, next);

	let lastIds = lastMessageIds.get(owner);
	if (!lastIds) {
		lastIds = new Map<string, string | undefined>();
		lastMessageIds.set(owner, lastIds);
	}
	lastIds.set(channelId, messageId);

	return next;
}

export function getDiscordChannelMessageSequence(
	owner: object | undefined,
	channelId: string | undefined,
): number {
	if (!owner || !channelId) {
		return 0;
	}
	return ensureSequenceMap(owner).get(channelId) ?? 0;
}

export interface DiscordStalenessDecision {
	shouldSend: boolean;
	stale: boolean;
	messagesSinceTurnStart: number;
	behavior: DiscordStalenessBehavior;
}

export function applyDiscordStalenessGuard(options: {
	config: DiscordStalenessConfig;
	owner: object | undefined;
	message: DiscordMessage;
	startSequence: number;
	content: Content;
}): DiscordStalenessDecision {
	const { config, owner, message, startSequence, content } = options;
	if (!config.enabled || config.behavior === "ignore") {
		return {
			shouldSend: true,
			stale: false,
			messagesSinceTurnStart: 0,
			behavior: config.behavior,
		};
	}

	const currentSequence = getDiscordChannelMessageSequence(
		owner,
		message.channel?.id,
	);
	const messagesSinceTurnStart = Math.max(0, currentSequence - startSequence);
	const stale = messagesSinceTurnStart > config.threshold;
	if (!stale) {
		return {
			shouldSend: true,
			stale: false,
			messagesSinceTurnStart,
			behavior: config.behavior,
		};
	}

	if (config.behavior === "skip") {
		return {
			shouldSend: false,
			stale: true,
			messagesSinceTurnStart,
			behavior: config.behavior,
		};
	}

	if (
		config.behavior === "tag" &&
		typeof content.text === "string" &&
		content.text.trim().length > 0 &&
		!/^(\s*\(catching up:\))/i.test(content.text)
	) {
		content.text = `(catching up:) ${content.text}`;
	}

	return {
		shouldSend: true,
		stale: true,
		messagesSinceTurnStart,
		behavior: config.behavior,
	};
}
