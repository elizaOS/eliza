/**
 * Tests for `resolveDiscordRespondPolicy` / `logResolvedDiscordPolicy` — the
 * single resolution point for the Discord respond/allowlist flags that
 * historically lived in three layers with different casing and undocumented
 * precedence:
 *
 *   - env `DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS` (via runtime.getSetting)
 *   - flat `character.settings["DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS"]`
 *     (string "true"/"false")
 *   - typed `character.settings.discord.shouldRespondOnlyToMentions` (boolean)
 *   - plus `CHANNEL_IDS` vs `settings.discord.allowedChannelIds`
 *
 * Documented precedence (highest wins): character.settings.discord object >
 * flat character settings > env/runtime > DISCORD_DEFAULTS. The resolver also
 * reports WHICH layer supplied each value so the boot banner can print an
 * honest one-line provenance summary, and `getDiscordSettings` consumes the
 * same resolver so the strict-mode gate and the banner can never disagree.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDiscordSettings,
	logResolvedDiscordPolicy,
	resolveDiscordRespondPolicy,
} from "../environment";

const POLICY_ENV_KEYS = [
	"DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
	"DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
	"DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
	"CHANNEL_IDS",
] as const;

beforeEach(() => {
	for (const key of POLICY_ENV_KEYS) {
		delete process.env[key];
	}
});

function runtimeWith(options: {
	discord?: Record<string, unknown>;
	flat?: Record<string, unknown>;
	env?: Record<string, unknown>;
}): IAgentRuntime {
	const info = vi.fn();
	return {
		agentId: "00000000-0000-0000-0000-0000000000aa",
		character: {
			settings: {
				...(options.flat ?? {}),
				...(options.discord ? { discord: options.discord } : {}),
			},
		},
		getSetting: (key: string) => options.env?.[key],
		logger: { info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
}

describe("resolveDiscordRespondPolicy precedence", () => {
	it("typed character.settings.discord wins over flat settings AND env", () => {
		const runtime = runtimeWith({
			discord: { shouldRespondOnlyToMentions: false },
			flat: { DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: "true" },
			env: { DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: "true" },
		});
		const policy = resolveDiscordRespondPolicy(runtime);
		expect(policy.mentionsOnly.value).toBe(false);
		expect(policy.mentionsOnly.source).toBe("character.settings.discord");
	});

	it("typed layer accepts a string 'false' arriving from deserialized character JSON", () => {
		const runtime = runtimeWith({
			discord: { shouldRespondOnlyToMentions: "false" },
			env: { DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: "true" },
		});
		const policy = resolveDiscordRespondPolicy(runtime);
		expect(policy.mentionsOnly.value).toBe(false);
		expect(policy.mentionsOnly.source).toBe("character.settings.discord");
	});

	it("flat character settings win over env when the typed object is absent", () => {
		const runtime = runtimeWith({
			flat: { DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: "true" },
			env: { DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: "false" },
		});
		const policy = resolveDiscordRespondPolicy(runtime);
		expect(policy.mentionsOnly.value).toBe(true);
		expect(policy.mentionsOnly.source).toBe("character.settings");
	});

	it("env supplies the value when no character layer sets it", () => {
		const runtime = runtimeWith({
			env: { DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: "true" },
		});
		const policy = resolveDiscordRespondPolicy(runtime);
		expect(policy.mentionsOnly.value).toBe(true);
		expect(policy.mentionsOnly.source).toBe("env");
	});

	it("falls through to the conversational defaults with full provenance", () => {
		const runtime = runtimeWith({});
		const policy = resolveDiscordRespondPolicy(runtime);
		expect(policy.mentionsOnly).toEqual({ value: false, source: "default" });
		expect(policy.ignoreBots).toEqual({ value: false, source: "default" });
		expect(policy.ignoreDMs).toEqual({ value: true, source: "default" });
		expect(policy.allowedChannelIds.source).toBe("default");
	});

	it("settings.discord.allowedChannelIds wins over CHANNEL_IDS env", () => {
		const runtime = runtimeWith({
			discord: { allowedChannelIds: ["111", "222"] },
			env: { CHANNEL_IDS: "999" },
		});
		const policy = resolveDiscordRespondPolicy(runtime);
		expect(policy.allowedChannelIds.value).toEqual(["111", "222"]);
		expect(policy.allowedChannelIds.source).toBe("character.settings.discord");
	});

	it("flat CHANNEL_IDS string beats env CHANNEL_IDS and parses csv", () => {
		const runtime = runtimeWith({
			flat: { CHANNEL_IDS: "111, 222 ,333" },
			env: { CHANNEL_IDS: "999" },
		});
		const policy = resolveDiscordRespondPolicy(runtime);
		expect(policy.allowedChannelIds.value).toEqual(["111", "222", "333"]);
		expect(policy.allowedChannelIds.source).toBe("character.settings");
	});

	it("env CHANNEL_IDS applies when no character layer configures channels", () => {
		const runtime = runtimeWith({ env: { CHANNEL_IDS: "444,555" } });
		const policy = resolveDiscordRespondPolicy(runtime);
		expect(policy.allowedChannelIds.value).toEqual(["444", "555"]);
		expect(policy.allowedChannelIds.source).toBe("env");
	});

	it("getDiscordSettings consumes the same resolver (no drift with the gate)", () => {
		const runtime = runtimeWith({
			discord: { shouldRespondOnlyToMentions: false },
			env: {
				DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: "true",
				CHANNEL_IDS: "777",
			},
		});
		const settings = getDiscordSettings(runtime);
		expect(settings.shouldRespondOnlyToMentions).toBe(false);
		expect(settings.allowedChannelIds).toEqual(["777"]);
	});
});

describe("logResolvedDiscordPolicy", () => {
	it("emits one INFO line naming resolved values and their sources", () => {
		const runtime = runtimeWith({
			discord: { shouldRespondOnlyToMentions: false },
			env: {
				DISCORD_SHOULD_IGNORE_BOT_MESSAGES: "true",
				CHANNEL_IDS: "123,456",
			},
		});
		logResolvedDiscordPolicy(runtime);
		const info = (runtime.logger.info as ReturnType<typeof vi.fn>).mock.calls;
		expect(info).toHaveLength(1);
		const line = String(info[0][1]);
		expect(line).toContain("[discord] resolved policy:");
		expect(line).toContain("mentionsOnly=false");
		expect(line).toContain("ignoreBots=true");
		expect(line).toContain("ignoreDMs=true");
		expect(line).toContain("allowedChannels=[123,456]");
		expect(line).toContain("mentionsOnly=character.settings.discord");
		expect(line).toContain("ignoreBots=env");
		expect(line).toContain("allowedChannels=env");
	});

	it("prints (all) when no channel allowlist is configured", () => {
		const runtime = runtimeWith({});
		logResolvedDiscordPolicy(runtime);
		const info = (runtime.logger.info as ReturnType<typeof vi.fn>).mock.calls;
		expect(String(info[0][1])).toContain("allowedChannels=(all)");
	});
});
