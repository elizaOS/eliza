/**
 * Locks the conversational out-of-box posture of the Discord connector: with no
 * env, character, or runtime overrides, the bot engages other bots, replies in a
 * channel without an @mention, and auto-answers. Exercises the real
 * `getDiscordSettings` resolver (env → runtime → character → DISCORD_DEFAULTS);
 * `DISCORD_DEFAULTS` is frozen at import time, so the default case clears the env
 * keys before a dynamic import to read them deterministically.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { validateDiscordConfig } from "../environment";

const POSTURE_ENV_KEYS = [
	"DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
	"DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
	"DISCORD_AUTO_REPLY",
	"DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
] as const;

function runtimeWith(settings: Record<string, unknown> = {}): IAgentRuntime {
	return {
		character: { settings: {} },
		getSetting: (key: string) => settings[key],
	} as unknown as IAgentRuntime;
}

describe("Discord default posture", () => {
	it("engages bots, replies without a mention, and auto-answers by default", async () => {
		for (const key of POSTURE_ENV_KEYS) {
			delete process.env[key];
		}
		const { getDiscordSettings } = await import("../environment");
		const settings = getDiscordSettings(runtimeWith());

		expect(settings.shouldIgnoreBotMessages).toBe(false);
		expect(settings.shouldRespondOnlyToMentions).toBe(false);
		expect(settings.autoReply).toBe(true);
		// DM ignore is unchanged — DMs still default to gated, not open.
		expect(settings.shouldIgnoreDirectMessages).toBe(true);
	});

	it("honors explicit overrides that restore the quiet, mention-gated posture", async () => {
		const { getDiscordSettings } = await import("../environment");
		const settings = getDiscordSettings(
			runtimeWith({
				DISCORD_SHOULD_IGNORE_BOT_MESSAGES: "true",
				DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: "true",
				DISCORD_AUTO_REPLY: "false",
			}),
		);

		expect(settings.shouldIgnoreBotMessages).toBe(true);
		expect(settings.shouldRespondOnlyToMentions).toBe(true);
		expect(settings.autoReply).toBe(false);
	});

	it("resolves the full settings surface from runtime values", async () => {
		const { getDiscordSettings } = await import("../environment");
		const settings = getDiscordSettings(
			runtimeWith({
				CHANNEL_IDS: "111, 222 , 333",
				DISCORD_DM_POLICY: "OPEN",
				DISCORD_ALLOW_FROM: "a, b",
				DISCORD_SYNC_PROFILE: "false",
				DISCORD_PROFILE_NAME: "  Nubilio  ",
				DISCORD_PROFILE_AVATAR: " https://cdn.test/a.png ",
			}),
		);

		expect(settings.allowedChannelIds).toEqual(["111", "222", "333"]);
		expect(settings.dmPolicy).toBe("open");
		expect(settings.allowFrom).toEqual(["a", "b"]);
		expect(settings.syncProfile).toBe(false);
		expect(settings.profileName).toBe("Nubilio");
		expect(settings.profileAvatar).toBe("https://cdn.test/a.png");
	});

	it("falls back to the default DM policy for an unrecognized value", async () => {
		const { getDiscordSettings } = await import("../environment");
		const settings = getDiscordSettings(
			runtimeWith({ DISCORD_DM_POLICY: "nonsense" }),
		);
		expect(settings.dmPolicy).toBe("pairing");
	});

	it("fails closed when the DISCORD_DM_POLICY env var itself is unrecognized", async () => {
		// DISCORD_DEFAULTS is frozen at import time, so the poisoned env must be
		// in place before a fresh module evaluation to exercise the default path.
		vi.resetModules();
		process.env.DISCORD_DM_POLICY = "pariing";
		try {
			const { DISCORD_DEFAULTS, getDiscordSettings } = await import(
				"../environment"
			);
			expect(DISCORD_DEFAULTS.DM_POLICY).toBe("pairing");
			expect(getDiscordSettings(runtimeWith()).dmPolicy).toBe("pairing");
		} finally {
			delete process.env.DISCORD_DM_POLICY;
			vi.resetModules();
		}
	});

	it("resolveDiscordDmPolicy accepts documented values and fails closed otherwise", async () => {
		const { resolveDiscordDmPolicy } = await import("../environment");
		expect(resolveDiscordDmPolicy(undefined)).toBe("pairing");
		expect(resolveDiscordDmPolicy("")).toBe("pairing");
		expect(resolveDiscordDmPolicy(" OPEN ")).toBe("open");
		expect(resolveDiscordDmPolicy("Allowlist")).toBe("allowlist");
		expect(resolveDiscordDmPolicy("disabled")).toBe("disabled");
		expect(resolveDiscordDmPolicy("open;drop")).toBe("pairing");
	});

	it("validateDiscordConfig parses a present token and rejects a missing one", async () => {
		await expect(
			validateDiscordConfig(runtimeWith({ DISCORD_API_TOKEN: "token" })),
		).resolves.toMatchObject({ DISCORD_API_TOKEN: "token" });

		await expect(validateDiscordConfig(runtimeWith())).rejects.toThrow(
			/Discord configuration validation failed/,
		);
	});
});
