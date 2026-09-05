import { describe, expect, it } from "vitest";
import { transformCommandToDiscordApi } from "../discord-commands";
import type { DiscordSlashCommand } from "../types";

describe("Discord surrogate-safe command description truncation", () => {
	it("truncates long command descriptions without splitting UTF-16 surrogate pairs", () => {
		// 98 ASCII chars + 1 emoji (2 UTF-16 code units) = 100 code units
		// With DISCORD_DESCRIPTION_MAX = 100, clampDescription caps at 99 chars + "…"
		// If the cut lands on the emoji (at index 98), truncateWellFormed backs off to 98 chars.
		const base = "a".repeat(98);
		const emoji = "🚀"; // \uD83D\uDE80 (2 code units)
		const longDesc = `${base}${emoji} extra trailing description`;

		const cmd: DiscordSlashCommand = {
			name: "test-cmd",
			description: longDesc,
			execute: async () => {},
		};

		const transformed = transformCommandToDiscordApi(cmd) as {
			name: string;
			description: string;
		};

		expect(transformed.description.endsWith("…")).toBe(true);
		// Check that the string is well-formed (no lone surrogates)
		expect(transformed.description.isWellFormed?.()).not.toBe(false);
		expect(transformed.description.charCodeAt(transformed.description.length - 2)).not.toBeGreaterThanOrEqual(0xd800);
	});
});
