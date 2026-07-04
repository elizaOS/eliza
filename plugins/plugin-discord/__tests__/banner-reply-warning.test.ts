/**
 * Unit tests for `warnIfRepliesSuppressed` — the startup banner warning that
 * fires when config would silently drop replies. Mocked settings, no live gateway.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { warnIfRepliesSuppressed } from "../banner.ts";

/**
 * A freshly-configured Discord bot can connect, ingest messages, and never
 * reply, because several independent default conditions each suppress all
 * replies with no log. `warnIfRepliesSuppressed` is the startup diagnostic that
 * names the active reason(s) and the exact env var(s) to flip. It is
 * diagnostics-only: it must warn exactly once when replies are globally
 * suppressed, name the specific active reason, and stay silent when every
 * reply-enabling condition is met.
 */

// Env vars `lifeOpsPassiveConnectorsEnabled` falls back to when the runtime has
// no override. Cleared per-test so process.env never leaks into assertions.
const PASSIVE_ENV_KEYS = [
	"ELIZA_LIFEOPS_PASSIVE_CONNECTORS",
	"LIFEOPS_PASSIVE_CONNECTORS",
] as const;

type SettingMap = Record<string, string | undefined>;

function makeRuntime(
	settings: SettingMap,
	characterSettings: Record<string, unknown> = {},
): {
	runtime: IAgentRuntime;
	warn: ReturnType<typeof vi.fn>;
} {
	const warn = vi.fn();
	const runtime = {
		agentId: "agent-1",
		character: { name: "TestBot", settings: characterSettings },
		getSetting: (key: string) => settings[key],
		logger: { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
	return { runtime, warn };
}

/**
 * Settings that satisfy every reply-enabling condition: passive mode explicitly
 * off, autoReply on, DMs not ignored, and DM policy open. `dmPolicy` must be set
 * to "open" because its default is "pairing", which would otherwise suppress DM
 * replies (issue #10216 root cause #1) and trip the DM-suppression diagnostic.
 */
function repliesEnabled(): SettingMap {
	return {
		// A token must be present or the diagnostic short-circuits (the bot can
		// never connect, so the missing-token warning owns that path instead).
		DISCORD_API_TOKEN: "test-token",
		ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
		DISCORD_AUTO_REPLY: "true",
		DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: "false",
		DISCORD_DM_POLICY: "open",
	};
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of PASSIVE_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of PASSIVE_ENV_KEYS) {
		if (savedEnv[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = savedEnv[key];
		}
	}
	vi.restoreAllMocks();
});

describe("warnIfRepliesSuppressed", () => {
	it("emits NO warning when every reply-enabling condition is met", () => {
		const { runtime, warn } = makeRuntime(repliesEnabled());
		warnIfRepliesSuppressed(runtime);
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns and names autoReply when autoReply is false", () => {
		const { runtime, warn } = makeRuntime({
			...repliesEnabled(),
			DISCORD_AUTO_REPLY: "false",
		});
		warnIfRepliesSuppressed(runtime);
		expect(warn).toHaveBeenCalledTimes(1);
		const message = String(warn.mock.calls[0]?.[1] ?? "");
		expect(message).toContain("autoReply");
		expect(message).toContain("DISCORD_AUTO_REPLY=true");
	});

	it("warns and names passive mode when passive connectors are enabled", () => {
		const { runtime, warn } = makeRuntime({
			...repliesEnabled(),
			ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "true",
		});
		warnIfRepliesSuppressed(runtime);
		expect(warn).toHaveBeenCalledTimes(1);
		const message = String(warn.mock.calls[0]?.[1] ?? "");
		expect(message).toContain("passive-connectors mode");
		expect(message).toContain("ELIZA_LIFEOPS_PASSIVE_CONNECTORS=false");
	});

	it("stays silent when no bot token is configured (cannot connect)", () => {
		// Passive on + autoReply off would normally warn, but with no token the
		// bot can never connect, so claiming a live connection would mislead.
		const { runtime, warn } = makeRuntime({
			ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "true",
			DISCORD_AUTO_REPLY: "false",
		});
		warnIfRepliesSuppressed(runtime);
		expect(warn).not.toHaveBeenCalled();
	});

	it("stays silent when a per-account autoReply re-enables replies", () => {
		// Base autoReply is off, but a per-account config turns it on for that
		// account, mirroring resolveDiscordSettingsForAccount. DMs are explicitly
		// opened (policy open + DMs not ignored) so this case isolates the
		// channel/global dimension. The bot is not globally silent and DMs are
		// open, so the diagnostic must NOT warn.
		const { runtime, warn } = makeRuntime(
			{
				ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
				DISCORD_AUTO_REPLY: "false",
				DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: "false",
				DISCORD_DM_POLICY: "open",
			},
			{
				discord: {
					accounts: {
						default: { token: "acct-token", autoReply: true },
					},
				},
			},
		);
		warnIfRepliesSuppressed(runtime);
		expect(warn).not.toHaveBeenCalled();
	});

	it("stays silent for a fully reply-enabled, DM-open account", () => {
		// autoReply on, passive off, DMs not ignored, dmPolicy open: nothing
		// suppresses replies in channels OR DMs, so neither warning fires.
		const { runtime, warn } = makeRuntime({
			DISCORD_API_TOKEN: "test-token",
			ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
			DISCORD_AUTO_REPLY: "true",
			DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: "false",
			DISCORD_DM_POLICY: "open",
		});
		warnIfRepliesSuppressed(runtime);
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns about DM suppression (naming DISCORD_DM_POLICY) when the default pairing policy gates a reply-enabled account", () => {
		// Channels reply (autoReply on, passive off, DMs not ignored), but the
		// DEFAULT dmPolicy 'pairing' silently drops unpaired DM senders. This is
		// issue #10216 root cause #1 and must surface as a DM-specific warning,
		// NOT the global "ANY messages" one.
		const { runtime, warn } = makeRuntime({
			DISCORD_API_TOKEN: "test-token",
			ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
			DISCORD_AUTO_REPLY: "true",
			DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: "false",
			// DISCORD_DM_POLICY intentionally unset -> defaults to "pairing".
		});
		warnIfRepliesSuppressed(runtime);
		expect(warn).toHaveBeenCalledTimes(1);
		const message = String(warn.mock.calls[0]?.[1] ?? "");
		expect(message).toContain("DM replies will be suppressed");
		expect(message).toContain("DISCORD_DM_POLICY");
		expect(message).toContain("pairing");
		// The bot DOES reply in channels, so the global warning must NOT fire.
		expect(message).not.toContain("will NOT auto-reply to any messages");
	});

	it("warns about DM suppression when shouldIgnoreDirectMessages is true while channels reply", () => {
		// Channels reply, but DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES drops DMs.
		// dmPolicy is open here so the ONLY surfaced reason is the ignore flag,
		// and the global "ANY messages" warning must stay silent.
		const { runtime, warn } = makeRuntime({
			DISCORD_API_TOKEN: "test-token",
			ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
			DISCORD_AUTO_REPLY: "true",
			DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: "true",
			DISCORD_DM_POLICY: "open",
		});
		warnIfRepliesSuppressed(runtime);
		expect(warn).toHaveBeenCalledTimes(1);
		const message = String(warn.mock.calls[0]?.[1] ?? "");
		expect(message).toContain("DM replies will be suppressed");
		expect(message).toContain("DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES=false");
		// Remediation must also point at DISCORD_DM_POLICY (default pairing still
		// gates DMs), not the misleading "flip one var and DMs work".
		expect(message).toContain("DISCORD_DM_POLICY");
		// Global warning must NOT fire — the bot still replies in channels.
		expect(message).not.toContain("will NOT auto-reply to any messages");
	});

	it("notes the allowFrom/allowlist exception in the DM-ignore wording", () => {
		// shouldIgnoreDirectMessages does NOT drop DMs from allowlisted/paired
		// users (messages.ts), so the wording must call out that exception.
		const { runtime, warn } = makeRuntime({
			DISCORD_API_TOKEN: "test-token",
			ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
			DISCORD_AUTO_REPLY: "true",
			DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: "true",
			DISCORD_DM_POLICY: "open",
		});
		warnIfRepliesSuppressed(runtime);
		const message = String(warn.mock.calls[0]?.[1] ?? "");
		expect(message).toContain("DISCORD_ALLOW_FROM");
		expect(message).toContain("allowlist");
	});
});
