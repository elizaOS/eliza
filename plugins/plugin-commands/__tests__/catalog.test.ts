import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	NAVIGATION_COMMANDS,
	resolveSettingsSection,
	SETTINGS_SECTION_ALIASES,
} from "../src/navigation-commands";
import {
	findCommandByAlias,
	getCommandsForSurface,
	getEnabledCommands,
	initForRuntime,
	registerCommand,
	resetCommands,
	serializeCommand,
	serializeCommands,
} from "../src/registry";
import type { CommandDefinition } from "../src/types";

describe("universal command catalog", () => {
	beforeEach(() => {
		initForRuntime("catalog-test");
	});
	afterEach(() => {
		resetCommands();
	});

	describe("navigation commands are seeded", () => {
		it("includes /settings, /orchestrator and /views in the default catalog", () => {
			const enabled = getEnabledCommands();
			const keys = new Set(enabled.map((c) => c.key));
			expect(keys.has("settings")).toBe(true);
			expect(keys.has("orchestrator")).toBe(true);
			expect(keys.has("views")).toBe(true);
		});

		it("resolves /settings via every declared alias", () => {
			for (const alias of ["/settings", "/preferences", "/config-ui"]) {
				const cmd = findCommandByAlias(alias);
				expect(cmd?.key).toBe("settings");
			}
		});

		it("tags navigation commands with a navigate target", () => {
			const settings = findCommandByAlias("/settings");
			expect(settings?.target).toEqual({
				kind: "navigate",
				tab: "settings",
				path: "/settings",
			});
			const orchestrator = findCommandByAlias("/orchestrator");
			expect(orchestrator?.target).toMatchObject({
				kind: "navigate",
				viewId: "orchestrator",
			});
		});

		it("marks /clear and /new as client commands limited to gui/tui", () => {
			const clear = findCommandByAlias("/clear");
			expect(clear?.target).toEqual({
				kind: "client",
				clientAction: "clear-chat",
			});
			expect(clear?.surfaces).toEqual(["gui", "tui"]);

			const fresh = findCommandByAlias("/new");
			expect(fresh?.target).toEqual({
				kind: "client",
				clientAction: "new-conversation",
			});
		});
	});

	describe("surface filtering", () => {
		it("excludes gui-only commands from connector surfaces", () => {
			const discord = getCommandsForSurface("discord");
			const discordKeys = new Set(discord.map((c) => c.key));
			// /fullscreen is gui-only
			expect(discordKeys.has("fullscreen")).toBe(false);
			// /settings is available everywhere (no surfaces restriction)
			expect(discordKeys.has("settings")).toBe(true);
		});

		it("includes commands with no surfaces on every surface", () => {
			const help = (s: "gui" | "tui" | "discord" | "telegram") =>
				getCommandsForSurface(s).some((c) => c.key === "help");
			expect(help("gui")).toBe(true);
			expect(help("tui")).toBe(true);
			expect(help("discord")).toBe(true);
			expect(help("telegram")).toBe(true);
		});

		it("keeps /fullscreen on gui only", () => {
			expect(
				getCommandsForSurface("gui").some((c) => c.key === "fullscreen"),
			).toBe(true);
			expect(
				getCommandsForSurface("tui").some((c) => c.key === "fullscreen"),
			).toBe(false);
		});
	});

	describe("serialization is wire-safe", () => {
		it("drops function-valued choices and keeps static ones", () => {
			const cmd: CommandDefinition = {
				key: "dyn",
				description: "dynamic",
				textAliases: ["/dyn"],
				scope: "both",
				acceptsArgs: true,
				args: [
					{
						name: "value",
						description: "v",
						choices: () => ["a", "b"],
					},
					{
						name: "static",
						description: "s",
						choices: ["x", "y"],
						dynamicChoices: "models",
					},
				],
			};
			const out = serializeCommand(cmd);
			// function choices dropped → undefined; static survives
			expect(out.args[0].choices).toBeUndefined();
			expect(out.args[1].choices).toEqual(["x", "y"]);
			expect(out.args[1].dynamicChoices).toBe("models");
			expect(JSON.stringify(out)).toContain('"key":"dyn"');
		});

		it("defaults target to agent and fills required booleans", () => {
			const out = serializeCommand({
				key: "plain",
				description: "p",
				textAliases: ["/plain"],
				scope: "both",
			});
			expect(out.target).toEqual({ kind: "agent" });
			expect(out.requiresAuth).toBe(false);
			expect(out.requiresElevated).toBe(false);
			expect(out.nativeName).toBe("plain");
			expect(out.acceptsArgs).toBe(false);
		});

		it("serializes the whole catalog to plain JSON", () => {
			const all = serializeCommands();
			expect(all.length).toBeGreaterThan(0);
			// Round-trips with no loss of JSON-representable data.
			const roundTripped = JSON.parse(JSON.stringify(all));
			expect(roundTripped).toEqual(all);
			const settings = all.find((c) => c.key === "settings");
			expect(settings?.target.kind).toBe("navigate");
		});

		it("respects the surface filter argument", () => {
			registerCommand({
				key: "gui-only",
				description: "g",
				textAliases: ["/gui-only"],
				scope: "text",
				surfaces: ["gui"],
			});
			expect(serializeCommands("gui").some((c) => c.key === "gui-only")).toBe(
				true,
			);
			expect(
				serializeCommands("telegram").some((c) => c.key === "gui-only"),
			).toBe(false);
		});
	});

	describe("resolveSettingsSection", () => {
		it("maps friendly tokens to canonical section ids", () => {
			expect(resolveSettingsSection("model")).toBe("ai-model");
			expect(resolveSettingsSection("providers")).toBe("ai-model");
			expect(resolveSettingsSection("voice")).toBe("voice");
			expect(resolveSettingsSection("vault")).toBe("secrets");
		});

		it("accepts the canonical id itself", () => {
			expect(resolveSettingsSection("ai-model")).toBe("ai-model");
			expect(resolveSettingsSection("connectors")).toBe("connectors");
		});

		it("returns undefined for unknown tokens", () => {
			expect(resolveSettingsSection("nonsense")).toBeUndefined();
			expect(resolveSettingsSection("")).toBeUndefined();
		});

		it("every alias list is non-empty and unique-mapped", () => {
			for (const section of SETTINGS_SECTION_ALIASES) {
				expect(section.aliases.length).toBeGreaterThan(0);
				for (const alias of section.aliases) {
					expect(resolveSettingsSection(alias)).toBe(section.id);
				}
			}
		});
	});

	describe("navigation catalog integrity", () => {
		it("every navigation command has stable aliases and a target", () => {
			for (const cmd of NAVIGATION_COMMANDS) {
				expect(cmd.textAliases.length).toBeGreaterThan(0);
				expect(cmd.textAliases.every((a) => a.startsWith("/"))).toBe(true);
				expect(cmd.target).toBeDefined();
			}
		});

		it("has no duplicate aliases across the whole default catalog", () => {
			const all = getEnabledCommands();
			const seen = new Map<string, string>();
			for (const cmd of all) {
				for (const alias of cmd.textAliases) {
					const key = alias.toLowerCase();
					expect(
						seen.has(key),
						`alias ${alias} duplicated by ${cmd.key} and ${seen.get(key)}`,
					).toBe(false);
					seen.set(key, cmd.key);
				}
			}
		});
	});
});
