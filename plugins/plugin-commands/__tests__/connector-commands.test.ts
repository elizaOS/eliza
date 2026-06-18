import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getConnectorCommands,
	getTelegramBotCommands,
	sanitizeConnectorName,
} from "../src/connector-commands";
import {
	initForRuntime,
	registerCommand,
	resetCommands,
} from "../src/registry";

describe("connector command mapping", () => {
	beforeEach(() => initForRuntime("connector-test"));
	afterEach(() => resetCommands());

	describe("sanitizeConnectorName", () => {
		it("lowercases and strips invalid chars for discord", () => {
			expect(sanitizeConnectorName("Open Chat!", "discord")).toBe("openchat");
			expect(sanitizeConnectorName("remote-plugins", "discord")).toBe(
				"remote-plugins",
			);
		});
		it("converts hyphens to underscores for telegram", () => {
			expect(sanitizeConnectorName("remote-plugins", "telegram")).toBe(
				"remote_plugins",
			);
			expect(sanitizeConnectorName("eliza-pair", "telegram")).toBe(
				"eliza_pair",
			);
		});
		it("caps at 32 chars", () => {
			expect(sanitizeConnectorName("a".repeat(50), "discord")).toHaveLength(32);
		});
	});

	describe("getConnectorCommands", () => {
		it("returns native-mapped commands for discord including /settings", () => {
			const cmds = getConnectorCommands("discord");
			const settings = cmds.find((c) => c.key === "settings");
			expect(settings).toBeDefined();
			expect(settings?.name).toBe("settings");
			// The section arg maps to an option with choices.
			expect(settings?.options[0]?.name).toBe("section");
			expect(settings?.options[0]?.choices.length).toBeGreaterThan(0);
			expect(settings?.target.kind).toBe("navigate");
		});

		it("excludes gui-only commands (e.g. /fullscreen)", () => {
			const keys = new Set(getConnectorCommands("discord").map((c) => c.key));
			expect(keys.has("fullscreen")).toBe(false);
		});

		it("clamps descriptions to 100 chars", () => {
			registerCommand({
				key: "longdesc-cmd",
				nativeName: "longdesc",
				description: "x".repeat(200),
				textAliases: ["/longdesc-cmd"],
				scope: "both",
			});
			const cmd = getConnectorCommands("discord").find(
				(c) => c.key === "longdesc-cmd",
			);
			expect(cmd).toBeDefined();
			expect(cmd?.description.length).toBeLessThanOrEqual(100);
		});

		it("de-dups by sanitized name (first wins)", () => {
			const names = getConnectorCommands("telegram").map((c) => c.name);
			expect(new Set(names).size).toBe(names.length);
		});

		it("caps option choices at 25", () => {
			registerCommand({
				key: "many-choices",
				nativeName: "many",
				description: "lots",
				textAliases: ["/many"],
				scope: "both",
				acceptsArgs: true,
				args: [
					{
						name: "pick",
						description: "pick one",
						choices: Array.from({ length: 40 }, (_, i) => `c${i}`),
					},
				],
			});
			const cmd = getConnectorCommands("discord").find(
				(c) => c.key === "many-choices",
			);
			expect(cmd?.options[0]?.choices).toHaveLength(25);
		});
	});

	describe("getTelegramBotCommands", () => {
		it("produces setMyCommands-shaped entries with valid names", () => {
			const entries = getTelegramBotCommands();
			expect(entries.length).toBeGreaterThan(0);
			for (const e of entries) {
				expect(e.command).toMatch(/^[a-z0-9_]{1,32}$/);
				expect(e.description.length).toBeGreaterThan(0);
				expect(e.description.length).toBeLessThanOrEqual(100);
			}
		});

		it("folds argument names into the description hint", () => {
			const settings = getTelegramBotCommands().find(
				(e) => e.command === "settings",
			);
			expect(settings?.description).toContain("<section>");
		});
	});
});
