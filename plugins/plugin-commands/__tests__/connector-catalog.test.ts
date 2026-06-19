import { describe, expect, it } from "vitest";
import { getConnectorCommands } from "../src/connector-catalog";

/**
 * The navigation half of the catalog must point at real app routes and expose
 * the in-app destinations on every surface, while keeping GUI/TUI-only client
 * commands off the chat connectors.
 */
describe("connector catalog — navigation surface", () => {
	const gui = getConnectorCommands("gui");
	const byName = (name: string) => gui.find((c) => c.name === name);

	it("exposes the full set of in-app navigation destinations", () => {
		const names = new Set(gui.map((c) => c.name));
		for (const expected of [
			"settings",
			"chat",
			"views",
			"orchestrator",
			"character",
			"knowledge",
			"wallet",
			"automations",
			"tasks",
			"skills",
			"plugins",
			"logs",
			"database",
		]) {
			expect(names.has(expected)).toBe(true);
		}
	});

	it("points navigation commands at canonical TAB_PATHS routes", () => {
		// These mirror @elizaos/ui navigation/index.ts TAB_PATHS.
		const expectedPaths: Record<string, string> = {
			settings: "/settings",
			chat: "/chat",
			views: "/views",
			character: "/character",
			knowledge: "/character/documents",
			wallet: "/wallet",
			automations: "/automations",
			tasks: "/apps/tasks",
			skills: "/apps/skills",
			plugins: "/apps/plugins",
			logs: "/apps/logs",
			database: "/apps/database",
		};
		for (const [name, path] of Object.entries(expectedPaths)) {
			const cmd = byName(name);
			expect(cmd?.target.kind).toBe("navigate");
			expect(
				cmd?.target.kind === "navigate" ? cmd.target.path : undefined,
			).toBe(path);
		}
	});

	it("carries a tab/viewId routing hint on every navigation command", () => {
		for (const cmd of gui) {
			if (cmd.target.kind !== "navigate") continue;
			expect(Boolean(cmd.target.tab || cmd.target.viewId)).toBe(true);
		}
	});

	it("keeps /settings's section option", () => {
		const settings = byName("settings");
		expect(settings?.options.some((o) => o.name === "section")).toBe(true);
	});

	it("never emits duplicate command names on any surface", () => {
		for (const surface of ["gui", "tui", "discord", "telegram"]) {
			const names = getConnectorCommands(surface).map((c) => c.name);
			expect(new Set(names).size).toBe(names.length);
		}
	});
});

describe("connector catalog — client command surface filtering", () => {
	it("emits client commands to the in-app surfaces (gui/tui)", () => {
		for (const surface of ["gui", "tui"]) {
			const names = new Set(getConnectorCommands(surface).map((c) => c.name));
			expect(names.has("clear")).toBe(true);
			expect(names.has("fullscreen")).toBe(true);
		}
	});

	it("filters client commands off chat connectors (discord/telegram)", () => {
		for (const surface of ["discord", "telegram"]) {
			const cmds = getConnectorCommands(surface);
			expect(cmds.some((c) => c.target.kind === "client")).toBe(false);
			const names = new Set(cmds.map((c) => c.name));
			expect(names.has("clear")).toBe(false);
			expect(names.has("fullscreen")).toBe(false);
		}
	});

	it("tags client commands with a concrete clientAction", () => {
		const clear = getConnectorCommands("gui").find((c) => c.name === "clear");
		expect(clear?.target.kind === "client" ? clear.target.clientAction : null).toBe(
			"clear-chat",
		);
	});
});
