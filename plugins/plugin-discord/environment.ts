/**
 * Discord connector config validation. Reads and validates env vars and
 * character settings into `DiscordSettings` and enforces the required
 * `DISCORD_API_TOKEN`.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { parseBooleanFromText } from "@elizaos/core";
import { z } from "zod";
import type { DiscordSettings } from "./types";

function getEnvBoolean(name: string, fallback: boolean): boolean {
	const value = process.env?.[name];
	if (!value) {
		return fallback;
	}
	return value.toLowerCase() === "true";
}

function getEnvArray(name: string, fallback: string[]): string[] {
	const value = process.env?.[name];
	if (!value || value.trim() === "") {
		return fallback;
	}
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

export const DISCORD_DEFAULTS = {
	// Default: engage other bots (agent-to-agent chat is a first-class use).
	// A cheap bot-noise triage gate (ELIZA_BOT_NOISE_TRIAGE, on by default)
	// still pre-filters unaddressed webhook/bot chatter before a full turn.
	SHOULD_IGNORE_BOT_MESSAGES: getEnvBoolean(
		"DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
		false,
	),
	SHOULD_IGNORE_DIRECT_MESSAGES: getEnvBoolean(
		"DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
		true,
	),
	// Default: reply in-channel without requiring an @mention. Set
	// DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS=true to restore mention-gating.
	SHOULD_RESPOND_ONLY_TO_MENTIONS: getEnvBoolean(
		"DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
		false,
	),
	ALLOWED_CHANNEL_IDS: getEnvArray("CHANNEL_IDS", []),
	DM_POLICY: (process.env?.DISCORD_DM_POLICY || "pairing") as
		| "open"
		| "allowlist"
		| "pairing"
		| "disabled",
	ALLOW_FROM: getEnvArray("DISCORD_ALLOW_FROM", []),
	SYNC_PROFILE: getEnvBoolean("DISCORD_SYNC_PROFILE", true),
} as const;

export const discordEnvSchema = z.object({
	DISCORD_API_TOKEN: z.string().min(1, "Discord API token is required"),
	CHANNEL_IDS: z
		.string()
		.nullish()
		.transform((val) =>
			val
				? val
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s.length > 0)
				: undefined,
		),
	DISCORD_SHOULD_IGNORE_BOT_MESSAGES: z
		.string()
		.nullish()
		.transform((val) => (val ? parseBooleanFromText(val) : undefined)),
	DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: z
		.string()
		.nullish()
		.transform((val) => (val ? parseBooleanFromText(val) : undefined)),
	DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: z
		.string()
		.nullish()
		.transform((val) => (val ? parseBooleanFromText(val) : undefined)),
});

export type DiscordConfig = z.infer<typeof discordEnvSchema>;

/**
 * Which configuration layer supplied a resolved respond-policy value.
 * Precedence (highest wins):
 *   1. `character.settings.discord.*` — the typed per-character object
 *   2. flat `character.settings["DISCORD_*"]` keys (string "true"/"false")
 *   3. env / runtime settings (`runtime.getSetting`, which also covers
 *      DB-seeded values re-imported from ELIZA_AGENT_CHARACTER_JSON at boot)
 *   4. `DISCORD_DEFAULTS`
 */
export type DiscordPolicySource =
	| "character.settings.discord"
	| "character.settings"
	| "env"
	| "default";

export interface ResolvedDiscordPolicyValue<T> {
	value: T;
	source: DiscordPolicySource;
}

/**
 * The respond/allowlist flags that historically existed in three layers with
 * different casing and undocumented precedence (env
 * `DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS`, flat character settings string,
 * typed `character.settings.discord.shouldRespondOnlyToMentions`, plus
 * `CHANNEL_IDS` vs `settings.discord.allowedChannelIds`). This is THE single
 * resolution result: both the strict-mode gate (via `getDiscordSettings`) and
 * the boot policy banner consume it, so they can never disagree again.
 */
export interface ResolvedDiscordRespondPolicy {
	mentionsOnly: ResolvedDiscordPolicyValue<boolean>;
	ignoreBots: ResolvedDiscordPolicyValue<boolean>;
	ignoreDMs: ResolvedDiscordPolicyValue<boolean>;
	allowedChannelIds: ResolvedDiscordPolicyValue<string[] | undefined>;
}

function readFlatCharacterSetting(
	runtime: IAgentRuntime,
	key: string,
): unknown {
	const settings = runtime.character?.settings;
	if (!settings || typeof settings !== "object") return undefined;
	return (settings as Record<string, unknown>)[key];
}

function parseChannelIdList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const entries = value
			.map((entry) => String(entry).trim())
			.filter((entry) => entry.length > 0);
		return entries;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	return undefined;
}

function resolveBooleanPolicy(
	runtime: IAgentRuntime,
	typedValue: unknown,
	envKey: string,
	defaultValue: boolean,
): ResolvedDiscordPolicyValue<boolean> {
	// The typed object is deserialized from character JSON, so a value that
	// SHOULD be boolean can arrive as the string "true"/"false". Both count as
	// the typed layer.
	if (typeof typedValue === "boolean") {
		return { value: typedValue, source: "character.settings.discord" };
	}
	if (typeof typedValue === "string" && typedValue.trim().length > 0) {
		return {
			value: parseBooleanFromText(typedValue),
			source: "character.settings.discord",
		};
	}
	const flat = readFlatCharacterSetting(runtime, envKey);
	if (typeof flat === "boolean") {
		return { value: flat, source: "character.settings" };
	}
	if (typeof flat === "string" && flat.trim().length > 0) {
		return { value: parseBooleanFromText(flat), source: "character.settings" };
	}
	const runtimeValue = runtime.getSetting(envKey);
	if (
		runtimeValue !== undefined &&
		runtimeValue !== null &&
		runtimeValue !== ""
	) {
		return {
			value:
				typeof runtimeValue === "boolean"
					? runtimeValue
					: parseBooleanFromText(String(runtimeValue)),
			source: "env",
		};
	}
	return { value: defaultValue, source: "default" };
}

/**
 * Resolve the effective Discord respond/allowlist policy from every
 * configuration layer with a single documented precedence:
 * `character.settings.discord` object > flat character settings > env /
 * runtime settings > defaults. Returns the resolved value AND the layer that
 * supplied it, so the boot banner can print an honest provenance line.
 */
export function resolveDiscordRespondPolicy(
	runtime: IAgentRuntime,
): ResolvedDiscordRespondPolicy {
	const characterSettings =
		(runtime.character?.settings &&
			(runtime.character.settings.discord as DiscordSettings)) ||
		{};

	const mentionsOnly = resolveBooleanPolicy(
		runtime,
		characterSettings.shouldRespondOnlyToMentions,
		"DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
		DISCORD_DEFAULTS.SHOULD_RESPOND_ONLY_TO_MENTIONS,
	);
	const ignoreBots = resolveBooleanPolicy(
		runtime,
		characterSettings.shouldIgnoreBotMessages,
		"DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
		DISCORD_DEFAULTS.SHOULD_IGNORE_BOT_MESSAGES,
	);
	const ignoreDMs = resolveBooleanPolicy(
		runtime,
		characterSettings.shouldIgnoreDirectMessages,
		"DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
		DISCORD_DEFAULTS.SHOULD_IGNORE_DIRECT_MESSAGES,
	);

	let allowedChannelIds: ResolvedDiscordPolicyValue<string[] | undefined>;
	const typedChannels = parseChannelIdList(characterSettings.allowedChannelIds);
	const flatChannels = parseChannelIdList(
		readFlatCharacterSetting(runtime, "CHANNEL_IDS"),
	);
	const envChannels = parseChannelIdList(runtime.getSetting("CHANNEL_IDS"));
	if (typedChannels !== undefined) {
		allowedChannelIds = {
			value: typedChannels.length > 0 ? typedChannels : undefined,
			source: "character.settings.discord",
		};
	} else if (flatChannels !== undefined) {
		allowedChannelIds = {
			value: flatChannels.length > 0 ? flatChannels : undefined,
			source: "character.settings",
		};
	} else if (envChannels !== undefined) {
		allowedChannelIds = {
			value: envChannels.length > 0 ? envChannels : undefined,
			source: "env",
		};
	} else {
		allowedChannelIds = {
			value:
				DISCORD_DEFAULTS.ALLOWED_CHANNEL_IDS.length > 0
					? [...DISCORD_DEFAULTS.ALLOWED_CHANNEL_IDS]
					: undefined,
			source: "default",
		};
	}

	return { mentionsOnly, ignoreBots, ignoreDMs, allowedChannelIds };
}

/**
 * One INFO line at boot naming the RESOLVED effective respond policy and
 * which configuration layer supplied each value. Before this line existed the
 * same flag lived in >=3 layers with different casing, boot re-seeded agent
 * DB settings from ELIZA_AGENT_CHARACTER_JSON (so DB edits silently
 * reverted), and nothing ever printed the winner: operators diagnosed silent
 * no-reply incidents by bisecting env files.
 */
export function logResolvedDiscordPolicy(runtime: IAgentRuntime): void {
	const policy = resolveDiscordRespondPolicy(runtime);
	const channels = policy.allowedChannelIds.value;
	const channelList = channels ? `[${channels.join(",")}]` : "(all)";
	runtime.logger?.info?.(
		{
			src: "plugin:discord",
			agentId: runtime.agentId,
			mentionsOnly: policy.mentionsOnly.value,
			ignoreBots: policy.ignoreBots.value,
			ignoreDMs: policy.ignoreDMs.value,
			allowedChannelIds: channels,
		},
		`[discord] resolved policy: mentionsOnly=${policy.mentionsOnly.value} ` +
			`ignoreBots=${policy.ignoreBots.value} ` +
			`ignoreDMs=${policy.ignoreDMs.value} ` +
			`allowedChannels=${channelList} ` +
			`(sources: mentionsOnly=${policy.mentionsOnly.source}, ` +
			`ignoreBots=${policy.ignoreBots.source}, ` +
			`ignoreDMs=${policy.ignoreDMs.source}, ` +
			`allowedChannels=${policy.allowedChannelIds.source})`,
	);
}

export function getDiscordSettings(runtime: IAgentRuntime): DiscordSettings {
	const characterSettings =
		(runtime.character.settings &&
			(runtime.character.settings.discord as DiscordSettings)) ||
		{};

	const resolveSetting = <T>(
		envKey: string,
		characterValue: T | undefined,
		defaultValue: T,
		transform?: (value: string) => T,
	): T => {
		const runtimeValue = runtime.getSetting(envKey);
		if (runtimeValue !== undefined && runtimeValue !== null) {
			const normalized =
				typeof runtimeValue === "string" ? runtimeValue : String(runtimeValue);
			return transform ? transform(normalized) : (runtimeValue as T);
		}
		return characterValue ?? defaultValue;
	};

	// The four respond/allowlist flags flow through the single resolver so the
	// strict-mode gate, the inbound allowlist, and the boot policy banner all
	// agree on the same effective values and precedence.
	const respondPolicy = resolveDiscordRespondPolicy(runtime);

	return {
		...characterSettings,
		shouldIgnoreBotMessages: respondPolicy.ignoreBots.value,

		shouldIgnoreDirectMessages: respondPolicy.ignoreDMs.value,

		shouldRespondOnlyToMentions: respondPolicy.mentionsOnly.value,

		allowedChannelIds: respondPolicy.allowedChannelIds.value,

		dmPolicy: resolveSetting(
			"DISCORD_DM_POLICY",
			characterSettings.dmPolicy,
			DISCORD_DEFAULTS.DM_POLICY,
			(value: string) => {
				const normalized = value.toLowerCase().trim();
				if (["open", "allowlist", "pairing", "disabled"].includes(normalized)) {
					return normalized as "open" | "allowlist" | "pairing" | "disabled";
				}
				return DISCORD_DEFAULTS.DM_POLICY;
			},
		),

		allowFrom: resolveSetting<string[]>(
			"DISCORD_ALLOW_FROM",
			characterSettings.allowFrom,
			DISCORD_DEFAULTS.ALLOW_FROM,
			(value: string) =>
				value
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s.length > 0),
		),

		syncProfile: resolveSetting(
			"DISCORD_SYNC_PROFILE",
			characterSettings.syncProfile,
			DISCORD_DEFAULTS.SYNC_PROFILE,
			parseBooleanFromText,
		),

		profileName: resolveSetting(
			"DISCORD_PROFILE_NAME",
			characterSettings.profileName,
			undefined,
			(value: string) => value.trim(),
		),

		profileAvatar: resolveSetting(
			"DISCORD_PROFILE_AVATAR",
			characterSettings.profileAvatar,
			undefined,
			(value: string) => value.trim(),
		),

		// Default: auto-answer messages. Set DISCORD_AUTO_REPLY=false to ingest
		// messages into memory without generating replies.
		autoReply: resolveSetting(
			"DISCORD_AUTO_REPLY",
			characterSettings.autoReply,
			true,
			parseBooleanFromText,
		),
	};
}

export async function validateDiscordConfig(
	runtime: IAgentRuntime,
): Promise<DiscordConfig> {
	try {
		const config = {
			DISCORD_API_TOKEN: runtime.getSetting("DISCORD_API_TOKEN"),
			CHANNEL_IDS: runtime.getSetting("CHANNEL_IDS"),
			DISCORD_SHOULD_IGNORE_BOT_MESSAGES: runtime.getSetting(
				"DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
			),
			DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: runtime.getSetting(
				"DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
			),
			DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: runtime.getSetting(
				"DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
			),
		};

		return discordEnvSchema.parse(config);
	} catch (error) {
		if (error instanceof z.ZodError) {
			const errorMessages = error.issues
				.map((err) => `${err.path.join(".")}: ${err.message}`)
				.join("\n");
			throw new Error(
				`Discord configuration validation failed:\n${errorMessages}`,
			);
		}
		throw error;
	}
}
