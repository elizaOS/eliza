/**
 * Asserts the connector-catalog navigation commands point at canonical in-app
 * routes (`TAB_PATHS`) and carry the tab/viewId routing hints. Pure data
 * assertions, deterministic.
 */
import { describe, expect, it } from "vitest";
import {
	commandVisibleForView,
	getConnectorCommands,
} from "../src/connector-catalog";
import {
	findCommandByKey,
	initForRuntime,
	registerCommand,
	useRuntime,
} from "../src/registry";

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
		expect(
			clear?.target.kind === "client" ? clear.target.clientAction : null,
		).toBe("clear-chat");
	});
});

describe("connector catalog — runtime-scoped registry projection", () => {
	it("projects runtime-registered commands and per-runtime enablement", () => {
		initForRuntime("connector-agent-a");
		useRuntime("connector-agent-a");
		const restart = findCommandByKey("restart");
		if (!restart) throw new Error("missing restart command");
		registerCommand({ ...restart, enabled: false });
		registerCommand({
			key: "skill-weather",
			description: "Answer weather questions with the weather skill",
			textAliases: ["/weather"],
			scope: "both",
			category: "skills",
			acceptsArgs: true,
		});

		const agentA = new Set(
			getConnectorCommands("discord", { agentId: "connector-agent-a" }).map(
				(command) => command.name,
			),
		);
		expect(agentA.has("restart")).toBe(false);
		expect(agentA.has("skill-weather")).toBe(true);

		initForRuntime("connector-agent-b");
		const agentB = new Set(
			getConnectorCommands("discord", { agentId: "connector-agent-b" }).map(
				(command) => command.name,
			),
		);
		expect(agentB.has("restart")).toBe(true);
		expect(agentB.has("skill-weather")).toBe(false);
	});
});

describe("connector catalog — view-scoped command visibility (#8798)", () => {
	it("treats global commands (no views) as always visible", () => {
		expect(commandVisibleForView(undefined, null)).toBe(true);
		expect(commandVisibleForView(undefined, "calendar")).toBe(true);
		expect(commandVisibleForView([], "calendar")).toBe(true);
	});

	it("shows a view-scoped command only while its view is active", () => {
		expect(commandVisibleForView(["calendar"], "calendar")).toBe(true);
		expect(commandVisibleForView(["calendar", "todos"], "todos")).toBe(true);
		expect(commandVisibleForView(["calendar"], "wallet")).toBe(false);
		// No active view → scoped commands are hidden.
		expect(commandVisibleForView(["calendar"], null)).toBe(false);
		expect(commandVisibleForView(["calendar"], undefined)).toBe(false);
	});

	it("never drops a global command when a view is active", () => {
		const noView = new Set(getConnectorCommands("gui").map((c) => c.name));
		const withView = new Set(
			getConnectorCommands("gui", { activeViewId: "wallet" }).map(
				(c) => c.name,
			),
		);
		// Every global command available with no active view stays available with
		// one (the active view only *adds* its scoped commands).
		for (const name of noView) expect(withView.has(name)).toBe(true);
	});

	it("surfaces a view-scoped command only while its view is foreground", () => {
		const calendarOnly = getConnectorCommands("gui", {
			activeViewId: "calendar",
		});
		const todosOnly = getConnectorCommands("gui", { activeViewId: "todos" });
		const noView = getConnectorCommands("gui");

		// calendar-add appears only under the calendar view, carrying its scope.
		const calAdd = calendarOnly.find((c) => c.name === "calendar-add");
		expect(calAdd).toBeDefined();
		expect(calAdd?.views).toEqual(["calendar"]);
		expect(noView.some((c) => c.name === "calendar-add")).toBe(false);
		expect(todosOnly.some((c) => c.name === "calendar-add")).toBe(false);

		// The todos view exposes its own pair and not the calendar command.
		const todosNames = new Set(todosOnly.map((c) => c.name));
		expect(todosNames.has("todos-add")).toBe(true);
		expect(todosNames.has("todos-done")).toBe(true);
		expect(todosNames.has("calendar-add")).toBe(false);
	});

	it("keeps view-dependent commands off chat connectors (no foreground view)", () => {
		// Even claiming a view active, Discord has no in-app view surface, so the
		// scoped commands are filtered by surface before the view filter applies.
		const discord = getConnectorCommands("discord", {
			activeViewId: "calendar",
		});
		expect(discord.some((c) => c.name === "calendar-add")).toBe(false);
	});
});
