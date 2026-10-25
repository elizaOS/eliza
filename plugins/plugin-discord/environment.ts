/**
 * Discord connector config validation. Reads and validates env vars and
 * character settings into `DiscordSettings` and enforces the required
 * `DISCORD_API_TOKEN`.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { logger, parseBooleanFromText } from "@elizaos/core";
import { z } from "zod";
import type { DiscordDmPolicy, DiscordSettings } from "./types";

/** DM gating modes accepted by `DISCORD_DM_POLICY`. */
const DISCORD_DM_POLICIES: readonly DiscordDmPolicy[] = [
	"open",
	"allowlist",
	"pairing",
	"disabled",
];

/** Unset or invalid `DISCORD_DM_POLICY` values fail closed to this policy. */
export const DEFAULT_DISCORD_DM_POLICY: DiscordDmPolicy = "pairing";

/**
 * Parse a raw `DISCORD_DM_POLICY` value. Blank or absent input yields the
 * default; unrecognized values (e.g. a typo like `pariing`) are warned about
 * and fail closed to the literal default rather than falling through the DM
 * access gate as an implicit `open`.
 */
export function resolveDiscordDmPolicy(raw: unknown): DiscordDmPolicy {
	if (raw === undefined || raw === null) {
		return DEFAULT_DISCORD_DM_POLICY;
	}
	const normalized = String(raw).trim().toLowerCase();
	if (!normalized) {
		return DEFAULT_DISCORD_DM_POLICY;
	}
	if ((DISCORD_DM_POLICIES as readonly string[]).includes(normalized)) {
		return normalized as DiscordDmPolicy;
	}
	logger.warn(
		{ src: "plugin:discord", policy: normalized },
		"Unrecognized DISCORD_DM_POLICY value; failing closed to the default pairing policy",
	);
	return DEFAULT_DISCORD_DM_POLICY;
}

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
	DM_POLICY: resolveDiscordDmPolicy(process.env?.DISCORD_DM_POLICY),
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

	const resolvedAllowedChannelIds = resolveSetting<string[]>(
		"CHANNEL_IDS",
		characterSettings.allowedChannelIds,
		DISCORD_DEFAULTS.ALLOWED_CHANNEL_IDS,
		(value: string) =>
			value
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0),
	);

	return {
		...characterSettings,
		shouldIgnoreBotMessages: resolveSetting(
			"DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
			characterSettings.shouldIgnoreBotMessages,
			DISCORD_DEFAULTS.SHOULD_IGNORE_BOT_MESSAGES,
			parseBooleanFromText,
		),

		shouldIgnoreDirectMessages: resolveSetting(
			"DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
			characterSettings.shouldIgnoreDirectMessages,
			DISCORD_DEFAULTS.SHOULD_IGNORE_DIRECT_MESSAGES,
			parseBooleanFromText,
		),

		shouldRespondOnlyToMentions: resolveSetting(
			"DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
			characterSettings.shouldRespondOnlyToMentions,
			DISCORD_DEFAULTS.SHOULD_RESPOND_ONLY_TO_MENTIONS,
			parseBooleanFromText,
		),

		allowedChannelIds:
			resolvedAllowedChannelIds.length > 0
				? resolvedAllowedChannelIds
				: undefined,

		dmPolicy: resolveSetting(
			"DISCORD_DM_POLICY",
			characterSettings.dmPolicy,
			DISCORD_DEFAULTS.DM_POLICY,
			(value: string) => resolveDiscordDmPolicy(value),
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
