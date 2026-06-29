/**
 * Discord Plugin Settings Banner
 * Beautiful ANSI art display for configuration on startup
 * Includes tiered permission system for invite URLs
 */

import type { IAgentRuntime } from "@elizaos/core";
import { lifeOpsPassiveConnectorsEnabled } from "@elizaos/core";
import { listEnabledDiscordAccounts } from "./accounts";
import { getDiscordSettings } from "./environment";
import {
	type DiscordPermissionValues,
	getPermissionValues,
} from "./permissions";

/** Per-account reply-config overrides used by the suppression diagnostic. */
type AccountReplyOverrides = {
	autoReply?: boolean;
	shouldIgnoreDirectMessages?: boolean;
};

/**
 * Inspect the effective Discord reply configuration and, if it will suppress
 * ALL auto-replies, emit a single startup warning naming the specific active
 * reason(s) and the exact env var(s) an operator must flip to re-enable replies.
 *
 * Diagnostics only: this reads resolved settings and logs. It never mutates
 * configuration or reply behavior. The reply gate it mirrors lives in
 * `MessageManager.handleMessage` (messages.ts): a reply is suppressed when
 * `!autoReply || lifeOpsPassiveConnectorsEnabled(runtime)`. DM ignore is a
 * narrower gate (DMs only) surfaced here because it silently drops DM replies.
 *
 * Multi-account aware: per-account configs can override `autoReply` /
 * `shouldIgnoreDirectMessages` (mirrors `resolveDiscordSettingsForAccount` in
 * service.ts: `config.X ?? base.X`). The warning fires only when EVERY enabled
 * account is globally suppressed, so a single reply-enabled account is never
 * misreported as silent.
 *
 * @param runtime - The agent runtime used to resolve settings and log.
 */
export function warnIfRepliesSuppressed(runtime: IAgentRuntime): void {
	// Skip the diagnostic when no enabled account has a token: index.ts still
	// runs the banner in that path, but the bot can never connect, so a
	// "Discord is connected but will NOT reply" warning would be misleading.
	// listEnabledDiscordAccounts is the same connection gate the service uses
	// (env DISCORD_API_TOKEN/DISCORD_BOT_TOKENS, character.settings.discord, and
	// per-account tokens all flow through it), so this covers every supported
	// credential path. The existing missing-token warning in index.ts owns the
	// no-credentials case.
	const accounts = listEnabledDiscordAccounts(runtime);
	if (accounts.length === 0) {
		return;
	}

	const base = getDiscordSettings(runtime);
	// Passive mode is a runtime-global gate (not per-account); when on it
	// suppresses replies for every account.
	const passiveEnabled = lifeOpsPassiveConnectorsEnabled(runtime);

	// Resolve each enabled account's effective reply settings, mirroring
	// resolveDiscordSettingsForAccount's `config.X ?? base.X` precedence.
	let anyAutoReplyOff = false;
	let anyDmIgnored = false;
	let allGloballySuppressed = true;

	for (const account of accounts) {
		const config = (account.config ?? {}) as AccountReplyOverrides;
		const effectiveAutoReply = config.autoReply ?? base.autoReply;
		const effectiveIgnoreDms =
			config.shouldIgnoreDirectMessages ?? base.shouldIgnoreDirectMessages;

		if (!effectiveAutoReply) {
			anyAutoReplyOff = true;
		}
		if (effectiveIgnoreDms) {
			anyDmIgnored = true;
		}
		// An account replies somewhere unless passive mode is on or its
		// effective autoReply is off.
		if (!passiveEnabled && effectiveAutoReply) {
			allGloballySuppressed = false;
		}
	}

	// Only warn when EVERY enabled account is globally suppressed. A lone
	// DM-ignore setting is intentional config, not a silent total failure, and
	// one reply-enabled account means the bot is not silent overall.
	if (!allGloballySuppressed) {
		return;
	}

	const reasons: string[] = [];
	if (passiveEnabled) {
		reasons.push(
			"passive-connectors mode is ON (inbound persisted, replies suppressed); " +
				"set ELIZA_LIFEOPS_PASSIVE_CONNECTORS=false " +
				"(or LIFEOPS_PASSIVE_CONNECTORS=false) to allow replies",
		);
	}
	if (anyAutoReplyOff) {
		reasons.push(
			"autoReply is OFF; set DISCORD_AUTO_REPLY=true " +
				"(or character.settings.discord.autoReply=true, or the per-account " +
				"autoReply) to allow replies",
		);
	}
	// Narrower suppressor: only silences DM replies. Surfaced alongside the
	// global reason(s) since the operator likely wants DMs working too.
	if (anyDmIgnored) {
		reasons.push(
			"direct messages are IGNORED (affects DM replies only); set " +
				"DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES=false to reply in DMs",
		);
	}

	runtime.logger.warn(
		{ src: "plugin:discord", agentId: runtime.agentId },
		`Discord is connected but will NOT auto-reply to any messages. Active reason(s): ${reasons
			.map((r, i) => `(${i + 1}) ${r}`)
			.join("; ")}.`,
	);
}

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	blue: "\x1b[34m",
	brightRed: "\x1b[91m",
	brightGreen: "\x1b[92m",
	brightYellow: "\x1b[93m",
	brightBlue: "\x1b[94m",
	brightMagenta: "\x1b[95m",
	brightCyan: "\x1b[96m",
	brightWhite: "\x1b[97m",
};

export interface PluginSetting {
	name: string;
	value: unknown;
	defaultValue?: unknown;
	sensitive?: boolean;
	required?: boolean;
}

export interface BannerOptions {
	pluginName: string;
	description?: string;
	settings: PluginSetting[];
	runtime: IAgentRuntime;
	/** Discord Application ID for generating invite URLs */
	applicationId?: string;
	/** Permission values for the 3x2 tier matrix */
	discordPermissions?: DiscordPermissionValues;
}

function mask(v: string): string {
	if (!v || v.length <= 8) {
		return "••••••••";
	}
	return `${v.slice(0, 4)}${"•".repeat(Math.min(12, v.length - 8))}${v.slice(-4)}`;
}

/**
 * Format a value for display in the banner.
 *
 * @param value - The value to format; may be `undefined`, `null`, or an empty string.
 * @param sensitive - Whether the value should be obfuscated for display.
 * @param maxLen - Maximum allowed length of the returned string; longer values are truncated with an ellipsis.
 * @returns A display string: `'(not set)'` if `value` is `undefined`, `null`, or an empty string; a masked representation if `sensitive` is true; otherwise the stringified value truncated to at most `maxLen` characters (truncated strings end with `'...'`).
 */
function fmtVal(value: unknown, sensitive: boolean, maxLen: number): string {
	let s: string;
	if (value === undefined || value === null || value === "") {
		s = "(not set)";
	} else if (sensitive) {
		s = mask(String(value));
	} else {
		s = String(value);
	}
	if (s.length > maxLen) {
		s = `${s.slice(0, maxLen - 3)}...`;
	}
	return s;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are required for terminal formatting
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Pads a string with trailing spaces until its visible (ANSI-stripped) length is at least the given width.
 *
 * @param s - The input string which may contain ANSI escape sequences.
 * @param n - The target visible width (number of characters) after padding.
 * @returns The original string if its visible length is >= `n`, otherwise the string with trailing spaces appended so its visible length equals `n`.
 */
function pad(s: string, n: number): string {
	const len = s.replace(ANSI_PATTERN, "").length;
	if (len >= n) {
		return s;
	}
	return s + " ".repeat(n - len);
}

function line(content: string): string {
	const len = content.replace(ANSI_PATTERN, "").length;

	if (len <= 78) {
		return content + " ".repeat(78 - len);
	}

	// Truncate based on visible character count, not raw string position
	// This avoids cutting in the middle of ANSI escape sequences
	let visibleCount = 0;
	let result = "";
	let i = 0;

	while (i < content.length && visibleCount < 78) {
		const remaining = content.slice(i);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are required for terminal formatting
		const match = remaining.match(/^\x1b\[[0-9;]*m/);

		if (match) {
			// Include ANSI sequence without counting toward visible length
			result += match[0];
			i += match[0].length;
		} else {
			// Regular visible character
			result += content[i];
			visibleCount++;
			i++;
		}
	}

	// Reset any unclosed ANSI sequences after truncation
	return result + ANSI.reset;
}

/**
 * Render a framed ANSI banner that displays plugin settings and, when available, tiered Discord invite URLs.
 *
 * The banner lists each setting with masked or truncated values, a status (custom/default/unset/required),
 * and an optional Discord invite section generated from `applicationId` and `discordPermissions`.
 *
 * @param options - Configuration for the banner, including `settings`, the `runtime` used to emit the banner,
 *                  and optional Discord invite data (`applicationId`, `discordPermissions`).
 */
export function printBanner(options: BannerOptions): void {
	const { settings, runtime } = options;
	const R = ANSI.reset,
		D = ANSI.dim,
		B = ANSI.bold;
	const c1 = ANSI.brightBlue,
		c2 = ANSI.brightCyan,
		c3 = ANSI.brightMagenta;

	const top = `${c1}╔${"═".repeat(78)}╗${R}`;
	const mid = `${c1}╠${"═".repeat(78)}╣${R}`;
	const bot = `${c1}╚${"═".repeat(78)}╝${R}`;
	const row = (s: string) => `${c1}║${R}${line(s)}${c1}║${R}`;

	const lines: string[] = [""];
	lines.push(top);
	lines.push(row(` ${B}Character: ${runtime.character.name}${R}`));
	lines.push(mid);
	lines.push(
		row(
			`${c2}     ██████╗ ██╗███████╗ ██████╗ ██████╗ ██████╗ ██████╗     ${c3}◖ ◗${R}`,
		),
	);
	lines.push(
		row(
			`${c2}     ██╔══██╗██║██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔══██╗   ${c3}◖===◗${R}`,
		),
	);
	lines.push(
		row(
			`${c2}     ██║  ██║██║███████╗██║     ██║   ██║██████╔╝██║  ██║    ${c3}╰─╯${R}`,
		),
	);
	lines.push(
		row(
			`${c2}     ██████╔╝██║╚════██║╚██████╗╚██████╔╝██║  ██║██████╔╝   ${c3}(◠◠)${R}`,
		),
	);
	lines.push(
		row(
			`${c2}     ╚═════╝ ╚═╝╚══════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═════╝     ${c3}‿‿${R}`,
		),
	);
	lines.push(
		row(
			`${D}            Bot Integration  •  Servers  •  Channels  •  Voice${R}`,
		),
	);
	lines.push(mid);

	const NW = 34,
		VW = 26,
		SW = 8;
	lines.push(
		row(
			` ${B}${pad("ENV VARIABLE", NW)} ${pad("VALUE", VW)} ${pad("STATUS", SW)}${R}`,
		),
	);
	lines.push(
		row(` ${D}${"-".repeat(NW)} ${"-".repeat(VW)} ${"-".repeat(SW)}${R}`),
	);

	for (const s of settings) {
		const set = s.value !== undefined && s.value !== null && s.value !== "";
		// Normalize to string for comparison (e.g., boolean false vs string 'false')
		const isDefault =
			set &&
			s.defaultValue !== undefined &&
			String(s.value) === String(s.defaultValue);

		let ico: string, st: string;
		if (!set && s.required) {
			ico = `${ANSI.brightRed}◆${R}`;
			st = `${ANSI.brightRed}REQUIRED${R}`;
		} else if (!set) {
			ico = `${D}○${R}`;
			st = `${D}unset${R}`;
		} else if (isDefault) {
			ico = `${ANSI.brightBlue}●${R}`;
			st = `${ANSI.brightBlue}default${R}`;
		} else {
			ico = `${ANSI.brightGreen}✓${R}`;
			st = `${ANSI.brightGreen}custom${R}`;
		}

		const name = pad(s.name, NW - 2);
		const val = pad(
			fmtVal(s.value ?? s.defaultValue, s.sensitive ?? false, VW),
			VW,
		);
		const status = pad(st, SW);
		lines.push(row(` ${ico} ${c2}${name}${R} ${val} ${status}`));
	}

	lines.push(mid);
	lines.push(
		row(
			` ${D}${ANSI.brightGreen}✓${D} custom  ${ANSI.brightBlue}●${D} default  ○ unset  ${ANSI.brightRed}◆${D} required      → Set in .env${R}`,
		),
	);
	lines.push(bot);

	// Add Discord invite links organized by voice capability
	if (options.applicationId && options.discordPermissions) {
		const p = options.discordPermissions;
		const baseUrl = `https://discord.com/api/oauth2/authorize?client_id=${options.applicationId}&scope=bot%20applications.commands&permissions=`;

		lines.push("");
		lines.push(`${B}${ANSI.brightCyan}🔗 Discord Bot Invite${R}`);
		lines.push("");
		lines.push(`   ${B}🎙️  With Voice:${R}`);
		lines.push(
			`   ${ANSI.brightGreen}● Basic${R}      ${baseUrl}${p.basicVoice}`,
		);
		lines.push(
			`   ${ANSI.brightYellow}● Moderator${R}  ${baseUrl}${p.moderatorVoice}`,
		);
		lines.push(
			`   ${ANSI.brightRed}● Admin${R}      ${baseUrl}${p.adminVoice}`,
		);
		lines.push("");
		lines.push(`   ${B}💬 Without Voice:${R}`);
		lines.push(`   ${ANSI.brightCyan}○ Basic${R}      ${baseUrl}${p.basic}`);
		lines.push(
			`   ${ANSI.brightMagenta}○ Moderator${R}  ${baseUrl}${p.moderator}`,
		);
		lines.push(`   ${ANSI.brightBlue}○ Admin${R}      ${baseUrl}${p.admin}`);
	}

	lines.push("");

	runtime.logger.info(lines.join("\n"));

	// Diagnostics: if the effective config will suppress all auto-replies, warn
	// the operator with the exact reason(s) instead of failing silently.
	warnIfRepliesSuppressed(runtime);
}

/**
 * Print the Discord plugin banner with current settings.
 */
export function printDiscordBanner(runtime: IAgentRuntime): void {
	// Get settings
	const apiToken = runtime.getSetting("DISCORD_API_TOKEN");
	const applicationId = runtime.getSetting("DISCORD_APPLICATION_ID");
	const ignoreBots = runtime.getSetting("DISCORD_SHOULD_IGNORE_BOT_MESSAGES");
	const ignoreDMs = runtime.getSetting("DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES");
	const onlyMentions = runtime.getSetting(
		"DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
	);
	const listenChannels = runtime.getSetting("DISCORD_LISTEN_CHANNEL_IDS");
	const voiceChannelId = runtime.getSetting("DISCORD_VOICE_CHANNEL_ID");

	printBanner({
		pluginName: "plugin-discord",
		description: "Discord bot integration for servers and channels",
		applicationId: applicationId ? String(applicationId) : undefined,
		discordPermissions: applicationId ? getPermissionValues() : undefined,
		settings: [
			{
				name: "DISCORD_API_TOKEN",
				value: apiToken,
				sensitive: true,
				required: true,
			},
			{ name: "DISCORD_APPLICATION_ID", value: applicationId },
			{ name: "DISCORD_VOICE_CHANNEL_ID", value: voiceChannelId },
			{ name: "DISCORD_LISTEN_CHANNEL_IDS", value: listenChannels },
			{
				name: "DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
				value: ignoreBots,
				defaultValue: "false",
			},
			{
				name: "DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
				value: ignoreDMs,
				defaultValue: "false",
			},
			{
				name: "DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
				value: onlyMentions,
				defaultValue: "false",
			},
		],
		runtime,
	});
}
