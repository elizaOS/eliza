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
import type { DiscordSettings } from "./types";

/** Per-account reply-config overrides used by the suppression diagnostic. */
type AccountReplyOverrides = {
	autoReply?: boolean;
	shouldIgnoreDirectMessages?: boolean;
	/** DM block (mirrors `DiscordAccountConfig.dm` in service.ts resolution). */
	dm?: {
		policy?: "open" | "allowlist" | "pairing" | "disabled";
		allowFrom?: Array<string | number>;
	};
};

/** DM policies that silently drop replies from un-allowlisted/unpaired senders. */
type RestrictiveDmPolicy = "allowlist" | "pairing" | "disabled";

/**
 * Resolve an account's effective DM allowlist, mirroring
 * `resolveDiscordSettingsForAccount` in service.ts (per-account `dm.allowFrom`
 * wins when non-empty, otherwise the base `allowFrom`).
 */
function resolveEffectiveAllowFrom(
	config: AccountReplyOverrides,
	base: DiscordSettings,
): string[] {
	const dmAllowFrom = config.dm?.allowFrom
		?.map((value) => String(value).trim())
		.filter((value) => value.length > 0);
	if (dmAllowFrom && dmAllowFrom.length > 0) {
		return dmAllowFrom;
	}
	return base.allowFrom ?? [];
}

/**
 * Build the remediation message for a restrictive DM policy value. Every variant
 * points at DISCORD_DM_POLICY (and the allowFrom escape hatch) so an operator is
 * not misled into flipping only one var.
 */
function dmPolicyReason(policy: RestrictiveDmPolicy): string {
	if (policy === "disabled") {
		return (
			"DISCORD_DM_POLICY='disabled' drops ALL direct messages; set " +
			"DISCORD_DM_POLICY=open (or character.settings.discord.dmPolicy) to reply in DMs"
		);
	}
	if (policy === "allowlist") {
		return (
			"DISCORD_DM_POLICY='allowlist' only replies to senders in DISCORD_ALLOW_FROM " +
			"or the dynamic pairing allowlist; set DISCORD_DM_POLICY=open, or add senders to " +
			"DISCORD_ALLOW_FROM (or character.settings.discord.allowFrom), to reply in DMs"
		);
	}
	// "pairing" is the default and is issue #10216 root cause #1.
	return (
		"DISCORD_DM_POLICY='pairing' (the default) requires each new DM sender to " +
		"complete pairing before the agent replies, so unpaired senders are silently " +
		"dropped; set DISCORD_DM_POLICY=open to reply to all DMs, or add allowed senders " +
		"to DISCORD_ALLOW_FROM (or character.settings.discord.allowFrom)"
	);
}

/**
 * Inspect the effective Discord reply configuration and emit up to one startup
 * warning per distinct failure mode, naming the specific active reason(s) and
 * the exact env var(s) an operator must flip to re-enable replies.
 *
 * Two independent diagnostics, because the suppressors live at different scopes:
 *
 *   1. GLOBAL — when EVERY enabled account is globally suppressed (passive mode
 *      on, or every account's `autoReply` off) the bot replies to NOTHING. One
 *      "will NOT auto-reply to ANY messages" warning, naming passive/autoReply.
 *
 *   2. DM-ONLY — when the bot DOES reply in channels but DM replies are still
 *      silently dropped by `shouldIgnoreDirectMessages` and/or a restrictive
 *      `dmPolicy` (the default 'pairing' blocks unpaired senders — issue #10216
 *      root cause #1). A SEPARATE "channel replies are enabled but DM replies
 *      will be suppressed" warning. The two are mutually exclusive: if the bot
 *      replies to nothing, the DM detail is moot, so only the global one fires.
 *
 * Diagnostics only: this reads resolved settings and logs. It never mutates
 * configuration or reply behavior. The gates it mirrors live in
 * `MessageManager.handleMessage` (messages.ts): the channel/global gate is
 * `!autoReply || lifeOpsPassiveConnectorsEnabled(runtime)`; the DM gate is
 * `shouldIgnoreDirectMessages` (with an allowFrom/dynamic-allowlist exception)
 * plus the `dmPolicy` access check in `checkDmAccess`.
 *
 * Multi-account aware: per-account configs can override `autoReply`,
 * `shouldIgnoreDirectMessages`, and `dm.policy`/`dm.allowFrom` (mirrors
 * `resolveDiscordSettingsForAccount` in service.ts: `config.X ?? base.X`). DM
 * suppression is only flagged on accounts that actually reply in channels, so a
 * fully-silent account is reported once (global), not twice.
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
	let anyReplyEnabled = false;

	// DM-suppression tracking, scoped to accounts that DO reply in channels: an
	// account that replies to nothing is covered by the global warning instead.
	let dmIgnoredOnReplyEnabled = false;
	const restrictiveDmPolicies = new Set<RestrictiveDmPolicy>();

	for (const account of accounts) {
		const config = (account.config ?? {}) as AccountReplyOverrides;
		const effectiveAutoReply = config.autoReply ?? base.autoReply;
		const effectiveIgnoreDms =
			config.shouldIgnoreDirectMessages ?? base.shouldIgnoreDirectMessages;
		const effectiveDmPolicy = config.dm?.policy ?? base.dmPolicy ?? "pairing";
		const hasAllowFrom = resolveEffectiveAllowFrom(config, base).length > 0;

		if (!effectiveAutoReply) {
			anyAutoReplyOff = true;
		}

		// An account replies in channels unless passive mode is on or its
		// effective autoReply is off. DM suppression only matters for accounts
		// that reply in channels — otherwise the global gate already silences it.
		const replyEnabledInChannels = !passiveEnabled && effectiveAutoReply;
		if (!replyEnabledInChannels) {
			continue;
		}
		anyReplyEnabled = true;

		if (effectiveIgnoreDms) {
			dmIgnoredOnReplyEnabled = true;
		}
		// A restrictive dmPolicy with no static allowlist drops unpaired/
		// non-allowlisted senders. With an allowFrom list configured the operator
		// has deliberately scoped DM access, so the policy itself isn't flagged.
		if (effectiveDmPolicy !== "open" && !hasAllowFrom) {
			restrictiveDmPolicies.add(effectiveDmPolicy);
		}
	}

	// Case 1 (GLOBAL): every enabled account is globally suppressed, so the bot
	// will not reply to ANY message — channel or DM. A lone reply-enabled account
	// means the bot is not silent overall, so this branch is skipped then.
	if (!anyReplyEnabled) {
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

		runtime.logger.warn(
			{ src: "plugin:discord", agentId: runtime.agentId },
			`Discord is connected but will NOT auto-reply to any messages. Active reason(s): ${reasons
				.map((r, i) => `(${i + 1}) ${r}`)
				.join("; ")}.`,
		);
		return;
	}

	// Case 2 (DM-ONLY): channel replies work, but DM replies are silently dropped
	// by the DM-ignore flag and/or a restrictive dmPolicy (the default 'pairing'
	// blocks unpaired senders — issue #10216 root cause #1). Case 1's global gate
	// returns above, so this branch handles the DM-only sub-case it does not cover.
	const dmReasons: string[] = [];
	if (dmIgnoredOnReplyEnabled) {
		dmReasons.push(
			"DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES is ON, so DMs are dropped except " +
				"from senders in DISCORD_ALLOW_FROM or the dynamic pairing allowlist; set " +
				"DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES=false to reply in DMs — note this " +
				"alone is not enough, as DISCORD_DM_POLICY (default 'pairing') still gates " +
				"DMs, so also set DISCORD_DM_POLICY=open or add senders to DISCORD_ALLOW_FROM",
		);
	}
	for (const policy of restrictiveDmPolicies) {
		dmReasons.push(dmPolicyReason(policy));
	}

	if (dmReasons.length === 0) {
		return;
	}

	runtime.logger.warn(
		{ src: "plugin:discord", agentId: runtime.agentId },
		`Discord channel replies are enabled but DM replies will be suppressed. Active reason(s): ${dmReasons
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
				defaultValue: "true",
			},
			{
				name: "DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
				value: ignoreDMs,
				defaultValue: "true",
			},
			{
				name: "DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
				value: onlyMentions,
				defaultValue: "true",
			},
		],
		runtime,
	});
}
