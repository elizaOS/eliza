import { describe, expect, it } from "vitest";
import { normalizePluginName, resolvePluginDependencies } from "../src/plugin";

describe("normalizePluginName", () => {
	it("reconciles scoped, plugin-prefixed, and bare names", () => {
		expect(normalizePluginName("@elizaos/plugin-sql")).toBe("sql");
		expect(normalizePluginName("plugin-sql")).toBe("sql");
		expect(normalizePluginName("sql")).toBe("sql");
	});

	it("trims surrounding whitespace", () => {
		expect(normalizePluginName(" @elizaos/plugin-sql ")).toBe("sql");
		expect(normalizePluginName(" plugin-sql ")).toBe("sql");
	});

	it("leaves a bare plugin- prefix with nothing after it alone", () => {
		expect(normalizePluginName("plugin-")).toBe("plugin-");
	});
});

describe("resolvePluginDependencies with plugin-prefixed names", () => {
	it("resolves a scoped dependency to a plugin-sql named plugin", () => {
		const sql = { name: "plugin-sql", dependencies: [] };
		const app = {
			name: "@elizaos/plugin-app",
			dependencies: ["@elizaos/plugin-sql"],
		};
		const resolved = resolvePluginDependencies(
			// The dependent comes first in the map on purpose: only the
			// dependency edge may put `sql` ahead of it.
			new Map([
				["@elizaos/plugin-app", app],
				["plugin-sql", sql],
			]),
		);

		// The dependency must load before its dependent. On base the
		// scoped dependency never resolves, so the app loads first.
		expect(resolved.map((plugin) => plugin.name)).toEqual([
			"plugin-sql",
			"@elizaos/plugin-app",
		]);
	});

	it("resolves a plugin-prefixed dependency to a scoped plugin", () => {
		const sql = { name: "@elizaos/plugin-sql", dependencies: [] };
		const app = {
			name: "@elizaos/plugin-app",
			dependencies: ["plugin-sql"],
		};
		const resolved = resolvePluginDependencies(
			// The dependent comes first in the map on purpose: only the
			// dependency edge may put `sql` ahead of it.
			new Map([
				["@elizaos/plugin-app", app],
				["@elizaos/plugin-sql", sql],
			]),
		);

		expect(resolved.map((plugin) => plugin.name)).toEqual([
			"@elizaos/plugin-sql",
			"@elizaos/plugin-app",
		]);
	});
});
