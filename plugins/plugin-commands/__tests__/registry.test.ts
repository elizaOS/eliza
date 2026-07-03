import { beforeEach, describe, expect, it } from "vitest";
import {
	findCommandByAlias,
	findCommandByKey,
	getCommandsByCategory,
	getCommandsForRuntime,
	getEnabledCommands,
	initForRuntime,
	registerCommand,
	registerCommandForRuntime,
	resetCommands,
	startsWithCommand,
	unregisterCommand,
} from "../src/registry";
import type { CommandDefinition } from "../src/types";

/**
 * The per-runtime command store backs slash-command detection. Alias lookup is
 * case/space-insensitive; startsWithCommand must match a command only when the
 * alias is the whole token (followed by space/colon/end) so "/status" matches
 * but "/statusbar" does not; disabled commands are excluded from lookup; and
 * register/unregister mutate the active store with cache invalidation.
 */

const custom: CommandDefinition = {
	key: "frobnicate",
	description: "test command",
	textAliases: ["/frob", "/frobnicate"],
	scope: "both",
	category: "tools",
	enabled: true,
} as unknown as CommandDefinition;

beforeEach(() => {
	// Fresh isolated store per test.
	initForRuntime("test-registry-agent");
	resetCommands();
});

describe("alias lookup", () => {
	it("finds a built-in command by alias, case/space-insensitively", () => {
		const help = findCommandByAlias("/help");
		expect(help?.key).toBe("help");
		expect(findCommandByAlias("  /HELP ")?.key).toBe("help");
		expect(findCommandByAlias("/definitely-not-a-command")).toBeUndefined();
	});
});

describe("startsWithCommand", () => {
	it("matches a whole-token alias with args, not a longer word", () => {
		expect(startsWithCommand("/status")?.key).toBe("status");
		expect(startsWithCommand("/status now")?.key).toBe("status");
		expect(startsWithCommand("/status:foo")?.key).toBe("status");
		expect(startsWithCommand("/statusbar")).toBeUndefined();
		expect(startsWithCommand("hello there")).toBeUndefined();
	});
});

describe("register / unregister", () => {
	it("adds, finds, and removes a custom command", () => {
		registerCommand(custom);
		expect(findCommandByKey("frobnicate")?.key).toBe("frobnicate");
		expect(startsWithCommand("/frob")?.key).toBe("frobnicate");
		unregisterCommand("frobnicate");
		expect(findCommandByKey("frobnicate")).toBeUndefined();
		expect(findCommandByAlias("/frob")).toBeUndefined();
	});

	it("re-registering the same key replaces rather than duplicates", () => {
		registerCommand(custom);
		registerCommand({ ...custom, description: "updated" });
		const matches = getEnabledCommands().filter((c) => c.key === "frobnicate");
		expect(matches).toHaveLength(1);
		expect(matches[0].description).toBe("updated");
	});
});

describe("disabled commands + categories", () => {
	it("excludes disabled commands from enabled lookups", () => {
		registerCommand({ ...custom, enabled: false });
		expect(findCommandByAlias("/frob")).toBeUndefined();
		expect(getEnabledCommands().some((c) => c.key === "frobnicate")).toBe(
			false,
		);
	});

	it("getCommandsByCategory filters by category", () => {
		const status = getCommandsByCategory("status");
		expect(status.length).toBeGreaterThan(0);
		expect(status.every((c) => c.category === "status")).toBe(true);
	});
});

describe("per-runtime registration + clobber fix (item #12091-15)", () => {
	const agentId = "clobber-agent";

	it("registerCommandForRuntime targets the runtime store without a global useRuntime", () => {
		initForRuntime(agentId);
		registerCommandForRuntime(agentId, custom);
		const keys = getCommandsForRuntime(agentId).map((c) => c.key);
		expect(keys).toContain("frobnicate");
		// Defaults are still present alongside the custom registration.
		expect(keys).toContain("help");
	});

	it("initForRuntime re-seeds defaults but PRESERVES custom registrations", () => {
		initForRuntime(agentId);
		registerCommandForRuntime(agentId, custom);
		expect(
			getCommandsForRuntime(agentId).some((c) => c.key === "frobnicate"),
		).toBe(true);

		// A second init (previously reset the store to DEFAULT_COMMANDS, clobbering
		// commands other plugins registered earlier) must keep the custom command.
		initForRuntime(agentId);
		const keys = getCommandsForRuntime(agentId).map((c) => c.key);
		expect(keys).toContain("frobnicate");
		expect(keys).toContain("help");
	});
});
