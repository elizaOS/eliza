/**
 * Boot-wiring integration test.
 *
 * Proves the post-port architecture is actually reachable:
 *
 *   - `@elizaos/plugin-app-control` exports `appControlPlugin` whose
 *     `actions` array contains the unified `APP` action (and only that —
 *     no double-registration of the legacy LAUNCH_APP / CLOSE_APP /
 *     LIST_RUNNING_APPS).
 *
 *   - `@elizaos/core` re-exports the unified `PLUGIN` action via the
 *     basic-capabilities barrel, AND `pluginManagerCapability.actions`
 *     resolves to that single action — no leftover registration of the
 *     legacy CORE_STATUS / SEARCH_PLUGINS / GET_PLUGIN_DETAILS /
 *     LIST_EJECTED_PLUGINS as standalone actions.
 *
 *   - Both actions' `validate()` runs without throwing on a synthetic
 *     runtime/message and returns the expected boolean (gates on owner
 *     role; the agent-self path is the easiest happy case).
 *
 *   - The PLUGIN action carries similes that cover every legacy action
 *     name we deprecated, so old callers still resolve.
 *
 * This is the single test that would have caught the "PLUGIN action is
 * orphaned by default" regression I called out in the audit. If the
 * runtime ever reverts to registering the 4 separate built-in actions
 * instead of the unified PLUGIN, this fails immediately.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { appControlPlugin } from "../index.js";

// Pull the built-in capability + the unified PLUGIN action from
// `@elizaos/core` exactly the way the runtime does.
import {
	pluginAction,
	pluginManagerCapability,
} from "@elizaos/core";

function fakeRuntime(agentId = "agent-1"): IAgentRuntime {
	return { agentId } as unknown as IAgentRuntime;
}

function fakeMessage(entityId: string, text: string): Memory {
	return {
		entityId,
		roomId: "room-1",
		content: { text },
	} as unknown as Memory;
}

describe("boot wiring — APP action via plugin-app-control", () => {
	it("appControlPlugin registers exactly one action: APP", () => {
		expect(appControlPlugin.name).toBe("app-control");
		expect(appControlPlugin.actions).toBeDefined();
		const names = (appControlPlugin.actions ?? []).map((a) => a.name);
		expect(names).toEqual(["APP"]);
	});

	it("APP action declares all 5 sub-modes via the mode parameter enum", () => {
		const app = appControlPlugin.actions?.find((a) => a.name === "APP");
		expect(app).toBeDefined();
		const modeParam = app?.parameters?.find((p) => p.name === "mode");
		expect(modeParam).toBeDefined();
		const enumValues = (modeParam?.schema as { enum?: string[] })?.enum ?? [];
		expect(enumValues.sort()).toEqual(
			["create", "launch", "list", "load_from_directory", "relaunch"].sort(),
		);
	});

	it("APP action's validate runs without throwing for an agent-self message", async () => {
		const app = appControlPlugin.actions?.find((a) => a.name === "APP");
		if (!app?.validate) throw new Error("APP action missing validate");
		const result = await app.validate(
			fakeRuntime("agent-1"),
			fakeMessage("agent-1", "launch the babylon app"),
		);
		// Owner-self short-circuits to true; the keyword heuristic also fires.
		expect(result).toBe(true);
	});

	it("APP action's validate rejects unrelated chatter from a non-owner", async () => {
		const app = appControlPlugin.actions?.find((a) => a.name === "APP");
		if (!app?.validate) throw new Error("APP action missing validate");
		const result = await app.validate(
			fakeRuntime("agent-1"),
			fakeMessage("random-user", "good morning"),
		);
		// hasOwnerAccess returns false for a non-self / non-owner sender;
		// even if it didn't, the keyword heuristic also fails. Either way
		// validate must return false without throwing.
		expect(result).toBe(false);
	});
});

describe("boot wiring — PLUGIN action via @elizaos/core", () => {
	it("pluginAction is exported from @elizaos/core (no longer orphaned in workspace package)", () => {
		expect(pluginAction).toBeDefined();
		expect(pluginAction.name).toBe("PLUGIN");
	});

	it("pluginManagerCapability.actions is exactly [pluginAction] — no leftover legacy actions", () => {
		expect(pluginManagerCapability).toBeDefined();
		const names = (pluginManagerCapability.actions ?? []).map((a) => a.name);
		expect(names).toEqual(["PLUGIN"]);
	});

	it("PLUGIN action declares all 9 sub-modes via the mode parameter enum", () => {
		const modeParam = pluginAction.parameters?.find((p) => p.name === "mode");
		expect(modeParam).toBeDefined();
		const enumValues = (modeParam?.schema as { enum?: string[] })?.enum ?? [];
		expect(enumValues.sort()).toEqual(
			[
				"core_status",
				"create",
				"eject",
				"install",
				"list",
				"list_ejected",
				"reinject",
				"search",
				"sync",
			].sort(),
		);
	});

	it("PLUGIN action's similes cover every legacy single-purpose action name", () => {
		const similes = pluginAction.similes ?? [];
		const legacyNames = [
			"INSTALL_PLUGIN",
			"EJECT_PLUGIN",
			"SYNC_PLUGIN",
			"REINJECT_PLUGIN",
			"LIST_EJECTED_PLUGINS",
			"SEARCH_PLUGIN",
			"CORE_STATUS",
		];
		for (const legacy of legacyNames) {
			expect(similes).toContain(legacy);
		}
	});

	it("PLUGIN action's validate runs without throwing for a happy-path message", async () => {
		if (!pluginAction.validate) throw new Error("PLUGIN action missing validate");
		const result = await pluginAction.validate(
			fakeRuntime("agent-1"),
			fakeMessage("agent-1", "install the discord plugin"),
		);
		expect(result).toBe(true);
	});

	it("PLUGIN action's validate rejects unrelated chatter without throwing", async () => {
		if (!pluginAction.validate) throw new Error("PLUGIN action missing validate");
		const result = await pluginAction.validate(
			fakeRuntime("agent-1"),
			fakeMessage("random-user", "good morning"),
		);
		expect(result).toBe(false);
	});
});

describe("boot wiring — no double-registration between APP and PLUGIN", () => {
	it("APP and PLUGIN action names are distinct (no collision)", () => {
		const appName = appControlPlugin.actions?.[0]?.name;
		const pluginName = pluginAction.name;
		expect(appName).toBe("APP");
		expect(pluginName).toBe("PLUGIN");
		expect(appName).not.toBe(pluginName);
	});

	it("APP similes don't accidentally claim PLUGIN sub-mode names", () => {
		const appSimiles = appControlPlugin.actions?.[0]?.similes ?? [];
		const pluginNames = ["INSTALL_PLUGIN", "EJECT_PLUGIN", "SYNC_PLUGIN"];
		for (const reserved of pluginNames) {
			expect(appSimiles).not.toContain(reserved);
		}
	});

	it("PLUGIN similes don't accidentally claim APP sub-mode names", () => {
		const pluginSimiles = pluginAction.similes ?? [];
		const appNames = ["LAUNCH_APP", "CLOSE_APP", "LIST_RUNNING_APPS"];
		for (const reserved of appNames) {
			expect(pluginSimiles).not.toContain(reserved);
		}
	});
});
