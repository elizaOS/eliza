import { afterEach, describe, expect, it } from "vitest";
import type { Plugin } from "../types/plugin.ts";
import {
	applyPluginFilter,
	clearAllHooks,
	createPluginFilterHook,
	getPreRegisterHookCount,
	registerPreRegisterHook,
} from "./plugin-hooks.ts";

/**
 * Plugin allow/deny filtering controls which plugins a runtime loads — a
 * security/policy boundary. Matching is case-insensitive and accepts both the
 * full package name ("@elizaos/plugin-discord") and the short name ("discord").
 * allow is a whitelist applied first, deny a blacklist applied second; the hook
 * registry returns an unregister handle so registrations don't leak.
 */

const plugin = (name: string): Plugin => ({ name }) as Plugin;
const names = (r: { plugins: Plugin[] }) => r.plugins.map((p) => p.name);

afterEach(() => clearAllHooks());

describe("applyPluginFilter — allow list", () => {
	it("keeps only allowed plugins, matching short or full name", () => {
		const plugins = [
			plugin("@elizaos/plugin-discord"),
			plugin("@elizaos/plugin-telegram"),
			plugin("@elizaos/plugin-sql"),
		];
		const result = applyPluginFilter(plugins, {
			allow: ["discord", "@elizaos/plugin-sql"],
		});
		expect(names(result)).toEqual([
			"@elizaos/plugin-discord",
			"@elizaos/plugin-sql",
		]);
		expect(result.changes.length).toBeGreaterThan(0);
	});
});

describe("applyPluginFilter — deny list", () => {
	it("removes denied plugins (short name, case-insensitive)", () => {
		const plugins = [
			plugin("@elizaos/plugin-discord"),
			plugin("@elizaos/plugin-sql"),
		];
		const result = applyPluginFilter(plugins, { deny: ["DISCORD"] });
		expect(names(result)).toEqual(["@elizaos/plugin-sql"]);
	});

	it("applies allow first, then deny", () => {
		const plugins = [
			plugin("@elizaos/plugin-discord"),
			plugin("@elizaos/plugin-telegram"),
			plugin("@elizaos/plugin-sql"),
		];
		const result = applyPluginFilter(plugins, {
			allow: ["discord", "telegram"],
			deny: ["telegram"],
		});
		expect(names(result)).toEqual(["@elizaos/plugin-discord"]);
	});

	it("no config → passthrough", () => {
		const plugins = [plugin("@elizaos/plugin-sql")];
		expect(names(applyPluginFilter(plugins, {}))).toEqual([
			"@elizaos/plugin-sql",
		]);
	});

	it("matches exactly, never by substring: deny 'x' must not remove plugin-xai", () => {
		// plugin-x (the X/Twitter connector) and plugin-xai (the xAI model
		// provider) are both real plugins in this repo. A substring match makes
		// `deny: ["x"]` silently drop plugin-xai too — and `allow: ["x"]`
		// silently admit it past the whitelist.
		const plugins = [
			plugin("@elizaos/plugin-x"),
			plugin("@elizaos/plugin-xai"),
		];
		expect(names(applyPluginFilter(plugins, { deny: ["x"] }))).toEqual([
			"@elizaos/plugin-xai",
		]);
		expect(names(applyPluginFilter(plugins, { allow: ["x"] }))).toEqual([
			"@elizaos/plugin-x",
		]);
	});

	it("still matches a scopeless 'plugin-<name>' entry against the scoped package", () => {
		const plugins = [
			plugin("@elizaos/plugin-discord"),
			plugin("@elizaos/plugin-telegram"),
		];
		expect(
			names(applyPluginFilter(plugins, { deny: ["plugin-discord"] })),
		).toEqual(["@elizaos/plugin-telegram"]);
	});
});

describe("createPluginFilterHook", () => {
	it("builds a hook that filters the context plugins", () => {
		const hook = createPluginFilterHook({ deny: ["sql"] });
		const result = hook({
			plugins: [
				plugin("@elizaos/plugin-sql"),
				plugin("@elizaos/plugin-discord"),
			],
		} as never);
		expect(names(result)).toEqual(["@elizaos/plugin-discord"]);
	});
});

describe("hook registry", () => {
	it("register returns an unregister handle, count tracks live hooks", () => {
		expect(getPreRegisterHookCount()).toBe(0);
		const off = registerPreRegisterHook((ctx) => ({
			plugins: ctx.plugins,
			changes: [],
		}));
		expect(getPreRegisterHookCount()).toBe(1);
		off();
		expect(getPreRegisterHookCount()).toBe(0);
	});
});
