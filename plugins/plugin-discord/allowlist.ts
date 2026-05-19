import type { Guild, GuildMember, User } from "discord.js";
import type {
	DiscordAccountConfig,
	DiscordGuildChannelConfig,
	DiscordGuildEntry,
} from "./accounts";

/**
 * Normalized allowlist structure for Discord entities
 */
export interface DiscordAllowList {
	allowAll: boolean;
	ids: Set<string>;
	names: Set<string>;
}

/**
 * Match source type for allowlist matching
 */
export type AllowListMatchSource = "wildcard" | "id" | "name" | "tag";

/**
 * Result of an allowlist match operation
 */
export interface DiscordAllowListMatch {
	allowed: boolean;
	matchKey?: string;
	matchSource?: AllowListMatchSource;
}

/**
 * Match source for channel configuration
 */
export type ChannelMatchSource = "id" | "name" | "slug" | "wildcard" | "parent";

/**
 * Resolved channel configuration with match metadata
 */
export interface DiscordChannelConfigResolved {
	allowed: boolean;
	requireMention?: boolean;
	skills?: string[];
	enabled?: boolean;
	users?: Array<string | number>;
	systemPrompt?: string;
	autoThread?: boolean;
	matchKey?: string;
	matchSource?: ChannelMatchSource;
}

/**
 * Normalizes a Discord slug (channel name, guild name, etc.)
 * Converts to lowercase, removes special characters, replaces spaces with dashes
 */
export function normalizeDiscordSlug(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^#/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Formats a Discord user tag for matching
 */
export function formatDiscordUserTag(user: User | GuildMember): string {
	if ("user" in user) {
		return user.user.discriminator === "0"
			? user.user.username
			: `${user.user.username}#${user.user.discriminator}`;
	}
	return user.discriminator === "0"
		? user.username
		: `${user.username}#${user.discriminator}`;
}

/**
 * Normalizes a raw allowlist array into a structured DiscordAllowList
 */
export function normalizeDiscordAllowList(
	raw: Array<string | number> | undefined,
	prefixes: string[] = ["discord:", "user:", "pk:"],
): DiscordAllowList | null {
	if (!raw || raw.length === 0) {
		return null;
	}

	const ids = new Set<string>();
	const names = new Set<string>();
	const allowAll = raw.some((entry) => String(entry).trim() === "*");

	for (const entry of raw) {
		const text = String(entry).trim();
		if (!text || text === "*") {
			continue;
		}

		const normalized = normalizeDiscordSlug(text);

		// Check for mention format <@!123456> or <@123456>
		const maybeId = text.replace(/^<@!?/, "").replace(/>$/, "");
		if (/^\d+$/.test(maybeId)) {
			ids.add(maybeId);
			continue;
		}

		// Check for prefixed IDs
		const prefix = prefixes.find((p) => text.startsWith(p));
		if (prefix) {
			const candidate = text.slice(prefix.length);
			if (candidate) {
				ids.add(candidate);
			}
			continue;
		}

		// Otherwise treat as name/slug
		if (normalized) {
			names.add(normalized);
		}
	}

	return { allowAll, ids, names };
}

/**
 * Checks if a candidate matches the allowlist
 */
export function allowListMatches(
	list: DiscordAllowList,
	candidate: { id?: string; name?: string; tag?: string },
): boolean {
	if (list.allowAll) {
		return true;
	}

	if (candidate.id && list.ids.has(candidate.id)) {
		return true;
	}

	const slug = candidate.name ? normalizeDiscordSlug(candidate.name) : "";
	if (slug && list.names.has(slug)) {
		return true;
	}

	if (candidate.tag && list.names.has(normalizeDiscordSlug(candidate.tag))) {
		return true;
	}

	return false;
}

/**
 * Resolves an allowlist match with detailed match information
 */
export function resolveDiscordAllowListMatch(params: {
	allowList: DiscordAllowList;
	candidate: { id?: string; name?: string; tag?: string };
}): DiscordAllowListMatch {
	const { allowList, candidate } = params;

	if (allowList.allowAll) {
		return { allowed: true, matchKey: "*", matchSource: "wildcard" };
	}

	if (candidate.id && allowList.ids.has(candidate.id)) {
		return { allowed: true, matchKey: candidate.id, matchSource: "id" };
	}

	const nameSlug = candidate.name ? normalizeDiscordSlug(candidate.name) : "";
	if (nameSlug && allowList.names.has(nameSlug)) {
		return { allowed: true, matchKey: nameSlug, matchSource: "name" };
	}

	const tagSlug = candidate.tag ? normalizeDiscordSlug(candidate.tag) : "";
	if (tagSlug && allowList.names.has(tagSlug)) {
		return { allowed: true, matchKey: tagSlug, matchSource: "tag" };
	}

	return { allowed: false };
}

/**
 * Checks if a Discord user is allowed based on an allowlist
 */
export function resolveDiscordUserAllowed(params: {
	allowList?: Array<string | number>;
	userId: string;
	userName?: string;
	userTag?: string;
}): boolean {
	const allowList = normalizeDiscordAllowList(params.allowList, [
		"discord:",
		"user:",
		"pk:",
	]);
	if (!allowList) {
		return true;
	}

	return allowListMatches(allowList, {
		id: params.userId,
		name: params.userName,
		tag: params.userTag,
	});
}

/**
 * Checks if a user is authorized for commands in DMs
 */
export function resolveDiscordCommandAuthorized(params: {
	isDirectMessage: boolean;
	allowFrom?: Array<string | number>;
	author: User;
}): boolean {
	if (!params.isDirectMessage) {
		return true;
	}

	const allowList = normalizeDiscordAllowList(params.allowFrom, [
		"discord:",
		"user:",
		"pk:",
	]);
	if (!allowList) {
		return true;
	}

	return allowListMatches(allowList, {
		id: params.author.id,
		name: params.author.username,
		tag: formatDiscordUserTag(params.author),
	});
}

/**
 * Resolves guild entry configuration by ID or slug
 */
export function resolveDiscordGuildEntry(params: {
	guild?: Guild | null;
	guildEntries?: Record<string, DiscordGuildEntry>;
}): (DiscordGuildEntry & { id?: string }) | null {
	const { guild, guildEntries } = params;
	if (!guild || !guildEntries) {
		return null;
	}

	// Check by ID first
	const byId = guildEntries[guild.id];
	if (byId) {
		return { ...byId, id: guild.id };
	}

	// Check by slug
	const slug = normalizeDiscordSlug(guild.name ?? "");
	const bySlug = guildEntries[slug];
	if (bySlug) {
		return { ...bySlug, id: guild.id, slug: slug || bySlug.slug };
	}

	// Check for wildcard
	const wildcard = guildEntries["*"];
	if (wildcard) {
		return { ...wildcard, id: guild.id, slug: slug || wildcard.slug };
	}

	return null;
}

/**
 * Builds channel key candidates for matching
 */
function buildChannelKeyCandidates(
	id: string,
	slug?: string,
	name?: string,
	allowNameMatch = true,
): string[] {
	const keys: string[] = [id];

	if (allowNameMatch) {
		if (slug) {
			keys.push(slug);
		}
		if (name) {
			const nameSlug = normalizeDiscordSlug(name);
			if (nameSlug && nameSlug !== slug) {
				keys.push(nameSlug);
			}
		}
	}

	return keys;
}

/**
 * Resolves channel entry match from configuration
 */
function resolveChannelEntryMatch(
	channels: Record<string, DiscordGuildChannelConfig>,
	keys: string[],
	parentKeys?: string[],
): {
	entry: DiscordGuildChannelConfig;
	matchKey: string;
	matchSource: ChannelMatchSource;
} | null {
	// Try direct keys first
	for (const key of keys) {
		const entry = channels[key];
		if (entry) {
			const source: ChannelMatchSource = /^\d+$/.test(key) ? "id" : "name";
			return { entry, matchKey: key, matchSource: source };
		}
	}

	// Try parent keys if provided
	if (parentKeys) {
		for (const parentKey of parentKeys) {
			const entry = channels[parentKey];
			if (entry) {
				return { entry, matchKey: parentKey, matchSource: "parent" };
			}
		}
	}

	// Try wildcard
	const wildcard = channels["*"];
	if (wildcard) {
		return { entry: wildcard, matchKey: "*", matchSource: "wildcard" };
	}

	return null;
}

/**
 * Resolves channel configuration from guild info
 */
export function resolveDiscordChannelConfig(params: {
	guildInfo?: (DiscordGuildEntry & { id?: string }) | null;
	channelId: string;
	channelName?: string;
	channelSlug?: string;
}): DiscordChannelConfigResolved | null {
	const { guildInfo, channelId, channelName } = params;
	const channelSlug =
		params.channelSlug ??
		(channelName ? normalizeDiscordSlug(channelName) : "");
	const channels = guildInfo?.channels;

	if (!channels) {
		return null;
	}

	const keys = buildChannelKeyCandidates(channelId, channelSlug, channelName);
	const match = resolveChannelEntryMatch(channels, keys);

	if (!match) {
		return { allowed: false };
	}

	return {
		allowed: match.entry.allow !== false,
		requireMention: match.entry.requireMention,
		skills: match.entry.skills,
		enabled: match.entry.enabled,
		users: match.entry.users,
		systemPrompt: match.entry.systemPrompt,
		autoThread: match.entry.autoThread,
		matchKey: match.matchKey,
		matchSource: match.matchSource,
	};
}

/**
 * Resolves channel configuration with thread/parent fallback
 */
export function resolveDiscordChannelConfigWithFallback(params: {
	guildInfo?: (DiscordGuildEntry & { id?: string }) | null;
	channelId: string;
	channelName?: string;
	channelSlug?: string;
	parentId?: string;
	parentName?: string;
	parentSlug?: string;
	isThread?: boolean;
}): DiscordChannelConfigResolved | null {
	const {
		guildInfo,
		channelId,
		channelName,
		parentId,
		parentName,
		parentSlug,
		isThread = false,
	} = params;
	const channelSlug =
		params.channelSlug ??
		(channelName ? normalizeDiscordSlug(channelName) : "");
	const channels = guildInfo?.channels;

	if (!channels) {
		return null;
	}

	const resolvedParentSlug =
		parentSlug ?? (parentName ? normalizeDiscordSlug(parentName) : "");

	// For threads, don't match by name (thread names change)
	const keys = buildChannelKeyCandidates(
		channelId,
		channelSlug,
		channelName,
		!isThread,
	);

	const parentKeys =
		parentId || parentName || parentSlug
			? buildChannelKeyCandidates(
					parentId ?? "",
					resolvedParentSlug,
					parentName,
				)
			: undefined;

	const match = resolveChannelEntryMatch(channels, keys, parentKeys);

	if (!match) {
		return { allowed: false };
	}

	return {
		allowed: match.entry.allow !== false,
		requireMention: match.entry.requireMention,
		skills: match.entry.skills,
		enabled: match.entry.enabled,
		users: match.entry.users,
		systemPrompt: match.entry.systemPrompt,
		autoThread: match.entry.autoThread,
		matchKey: match.matchKey,
		matchSource: match.matchSource,
	};
}

/**
 * Determines if a mention is required for the bot to respond
 */
export function resolveDiscordShouldRequireMention(params: {
	isGuildMessage: boolean;
	isThread: boolean;
	botId?: string | null;
	threadOwnerId?: string | null;
	channelConfig?: DiscordChannelConfigResolved | null;
	guildInfo?: (DiscordGuildEntry & { id?: string }) | null;
	isAutoThreadOwnedByBot?: boolean;
}): boolean {
	if (!params.isGuildMessage) {
		return false;
	}

	// Don't require mention in threads created by the bot (autoThread)
	const isBotThread =
		params.isAutoThreadOwnedByBot ?? isDiscordAutoThreadOwnedByBot(params);
	if (isBotThread) {
		return false;
	}

	return (
		params.channelConfig?.requireMention ??
		params.guildInfo?.requireMention ??
		true
	);
}

/**
 * Checks if a thread was created by the bot via autoThread feature
 */
export function isDiscordAutoThreadOwnedByBot(params: {
	isThread: boolean;
	channelConfig?: DiscordChannelConfigResolved | null;
	botId?: string | null;
	threadOwnerId?: string | null;
}): boolean {
	if (!params.isThread) {
		return false;
	}

	if (!params.channelConfig?.autoThread) {
		return false;
	}

	const botId = params.botId?.trim();
	const threadOwnerId = params.threadOwnerId?.trim();

	return Boolean(botId && threadOwnerId && botId === threadOwnerId);
}

/**
 * Checks if a group (guild channel) is allowed by the policy
 */
export function isDiscordGroupAllowedByPolicy(params: {
	groupPolicy: "open" | "disabled" | "allowlist";
	guildAllowlisted: boolean;
	channelAllowlistConfigured: boolean;
	channelAllowed: boolean;
}): boolean {
	const {
		groupPolicy,
		guildAllowlisted,
		channelAllowlistConfigured,
		channelAllowed,
	} = params;

	if (groupPolicy === "disabled") {
		return false;
	}

	if (groupPolicy === "open") {
		return true;
	}

	// allowlist mode
	if (!guildAllowlisted) {
		return false;
	}

	if (!channelAllowlistConfigured) {
		return true;
	}

	return channelAllowed;
}

/**
 * Resolves if a group DM is allowed
 */
export function resolveGroupDmAllow(params: {
	channels?: Array<string | number>;
	channelId: string;
	channelName?: string;
	channelSlug?: string;
}): boolean {
	const { channels, channelId, channelName } = params;
	const channelSlug =
		params.channelSlug ??
		(channelName ? normalizeDiscordSlug(channelName) : "");

	if (!channels || channels.length === 0) {
		return true;
	}

	const allowList = new Set(
		channels.map((entry) => normalizeDiscordSlug(String(entry))),
	);
	const candidates = [
		normalizeDiscordSlug(channelId),
		channelSlug,
		channelName ? normalizeDiscordSlug(channelName) : "",
	].filter(Boolean);

	return (
		allowList.has("*") ||
		candidates.some((candidate) => allowList.has(candidate))
	);
}

/**
 * Determines if a reaction notification should be emitted
 */
export function shouldEmitDiscordReactionNotification(params: {
	mode?: "off" | "own" | "all" | "allowlist";
	botId?: string;
	messageAuthorId?: string;
	userId: string;
	userName?: string;
	userTag?: string;
	allowlist?: Array<string | number>;
}): boolean {
	const mode = params.mode ?? "own";

	if (mode === "off") {
		return false;
	}

	if (mode === "all") {
		return true;
	}

	if (mode === "own") {
		return Boolean(params.botId && params.messageAuthorId === params.botId);
	}

	if (mode === "allowlist") {
		const list = normalizeDiscordAllowList(params.allowlist, [
			"discord:",
			"user:",
			"pk:",
		]);
		if (!list) {
			return false;
		}

		return allowListMatches(list, {
			id: params.userId,
			name: params.userName,
			tag: params.userTag,
		});
	}

	return false;
}

/**
 * Validates a message against all allowlist policies
 */
export function validateMessageAllowed(params: {
	accountConfig: DiscordAccountConfig;
	isDirectMessage: boolean;
	isGroupDm: boolean;
	guild?: Guild | null;
	channelId: string;
	channelName?: string;
	author: User;
	botId?: string;
}): {
	allowed: boolean;
	reason?: string;
	channelConfig?: DiscordChannelConfigResolved | null;
	guildInfo?: (DiscordGuildEntry & { id?: string }) | null;
} {
	const {
		accountConfig,
		isDirectMessage,
		isGroupDm,
		guild,
		channelId,
		channelName,
		author,
	} = params;

	// Handle DMs
	if (isDirectMessage && !isGroupDm) {
		const dmConfig = accountConfig.dm;

		if (dmConfig?.enabled === false) {
			return { allowed: false, reason: "DMs disabled" };
		}

		const dmPolicy = dmConfig?.policy ?? "open";
		if (dmPolicy === "disabled") {
			return { allowed: false, reason: "DM policy disabled" };
		}

		if (dmPolicy === "allowlist" && dmConfig?.allowFrom) {
			const isAllowed = resolveDiscordUserAllowed({
				allowList: dmConfig.allowFrom,
				userId: author.id,
				userName: author.username,
				userTag: formatDiscordUserTag(author),
			});

			if (!isAllowed) {
				return { allowed: false, reason: "User not in DM allowlist" };
			}
		}

		return { allowed: true };
	}

	// Handle group DMs
	if (isGroupDm) {
		const dmConfig = accountConfig.dm;

		if (!dmConfig?.groupEnabled) {
			return { allowed: false, reason: "Group DMs disabled" };
		}

		const isAllowed = resolveGroupDmAllow({
			channels: dmConfig.groupChannels,
			channelId,
			channelName,
		});

		if (!isAllowed) {
			return { allowed: false, reason: "Group DM channel not allowed" };
		}

		return { allowed: true };
	}

	// Handle guild messages
	const groupPolicy = accountConfig.groupPolicy ?? "open";
	const guildInfo = resolveDiscordGuildEntry({
		guild,
		guildEntries: accountConfig.guilds,
	});

	const guildAllowlisted = guildInfo !== null;
	const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";

	const channelConfig = resolveDiscordChannelConfig({
		guildInfo,
		channelId,
		channelName,
		channelSlug,
	});

	const channelAllowlistConfigured = Boolean(guildInfo?.channels);
	const channelAllowed = channelConfig?.allowed ?? false;

	const isAllowed = isDiscordGroupAllowedByPolicy({
		groupPolicy,
		guildAllowlisted,
		channelAllowlistConfigured,
		channelAllowed,
	});

	if (!isAllowed) {
		return {
			allowed: false,
			reason: "Channel not allowed by policy",
			channelConfig,
			guildInfo,
		};
	}

	// Check user allowlist for channel
	if (channelConfig?.users) {
		const userAllowed = resolveDiscordUserAllowed({
			allowList: channelConfig.users,
			userId: author.id,
			userName: author.username,
			userTag: formatDiscordUserTag(author),
		});

		if (!userAllowed) {
			return {
				allowed: false,
				reason: "User not in channel allowlist",
				channelConfig,
				guildInfo,
			};
		}
	}

	// Check user allowlist for guild
	if (guildInfo?.users) {
		const userAllowed = resolveDiscordUserAllowed({
			allowList: guildInfo.users,
			userId: author.id,
			userName: author.username,
			userTag: formatDiscordUserTag(author),
		});

		if (!userAllowed) {
			return {
				allowed: false,
				reason: "User not in guild allowlist",
				channelConfig,
				guildInfo,
			};
		}
	}

	return { allowed: true, channelConfig, guildInfo };
}
