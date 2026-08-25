/**
 * Unit tests for `printDiscordBanner` — the startup settings panel. Mocked
 * runtime logger, no live gateway. Re-homes the conversational-default rows
 * assertion that previously lived in the deleted
 * `__tests__/discord-defaults-lane.test.ts` composite lane (#17003 / #17012
 * sweep), and pins the banner's hardcoded default markers to the live
 * `DISCORD_DEFAULTS` values so a default flip cannot silently desynchronize
 * the operator-facing panel.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { fmtVal, printDiscordBanner } from "../banner.ts";
import { DISCORD_DEFAULTS } from "../environment.ts";

function renderBanner(): string {
	const settings: Record<string, unknown> = {
		DISCORD_API_TOKEN: "token-value",
		DISCORD_APPLICATION_ID: "123456789012345678", // gitleaks:allow test fixture
	};
	const info = vi.fn();
	const runtime = {
		character: { name: "TestBot" },
		getSetting: (key: string) => settings[key],
		logger: { info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;

	printDiscordBanner(runtime);

	return info.mock.calls.map((call) => String(call[0])).join("\n");
}

function settingRow(rendered: string, name: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal ANSI color codes before asserting columns
	const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");
	const row = plain.split("\n").find((line) => line.includes(name));
	if (!row) throw new Error(`Missing banner row for ${name}`);
	return row;
}

describe("printDiscordBanner conversational defaults", () => {
	it("renders the startup banner with the response-gating rows", () => {
		const rendered = renderBanner();
		expect(rendered).toContain("DISCORD_SHOULD_IGNORE_BOT_MESSAGES");
		expect(rendered).toContain("DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES");
		expect(rendered).toContain("DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS");
	});

	it("keeps the banner's default markers in sync with DISCORD_DEFAULTS", () => {
		// The banner hardcodes each row's defaultValue string; these mirror the
		// conversational-default posture (#16956): engage bots, ignore DMs off is
		// NOT the default (DMs are ignored by default), reply without @mention.
		expect(DISCORD_DEFAULTS.SHOULD_IGNORE_BOT_MESSAGES).toBe(false);
		expect(DISCORD_DEFAULTS.SHOULD_IGNORE_DIRECT_MESSAGES).toBe(true);
		expect(DISCORD_DEFAULTS.SHOULD_RESPOND_ONLY_TO_MENTIONS).toBe(false);

		const rendered = renderBanner();
		expect(
			settingRow(rendered, "DISCORD_SHOULD_IGNORE_BOT_MESSAGES"),
		).toContain("false");
		expect(
			settingRow(rendered, "DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES"),
		).toContain("true");
		expect(
			settingRow(rendered, "DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS"),
		).toContain("false");
	});

	it("formats values safely without splitting surrogate pairs", () => {
		expect(fmtVal(undefined, false, 20)).toBe("(not set)");
		expect(fmtVal("secret-token", true, 20)).toBe("secr••••oken");

		// "𝄞" is U+1D11E (2 UTF-16 code units).
		// With maxLen=10, budget for text is 7 code units (10 - 3 for "...").
		// If string has 6 'a's followed by "𝄞" (at units 6 and 7), slicing at 7 would split the pair.
		const astralStr = `${"a".repeat(6)}\uD834\uDD1Eextra`;
		const formatted = fmtVal(astralStr, false, 10);
		expect(formatted.endsWith("...")).toBe(true);
		const prefix = formatted.slice(0, -3);
		expect(prefix.isWellFormed()).toBe(true);
		expect(prefix.length).toBe(6); // backed off by 1 unit to avoid splitting U+1D11E
	});
});
