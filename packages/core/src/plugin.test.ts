import { describe, expect, it, vi } from "vitest";
import * as pluginModule from "./plugin";
import { loadPlugin, type PluginResolver, resolvePlugins } from "./plugin";
import type { Plugin } from "./types";

const makePlugin = (name: string): Plugin => ({
	name,
	description: `${name} test plugin`,
});

describe("core plugin loader — no runtime install / no name imports", () => {
	it("exposes no auto-install or module-import entry points", () => {
		// The supply-chain surface (bun add / variable-specifier import) is gone:
		// core no longer exports tryInstallPlugin or loadAndPreparePlugin.
		expect(
			(pluginModule as Record<string, unknown>).tryInstallPlugin,
		).toBeUndefined();
		expect(
			(pluginModule as Record<string, unknown>).loadAndPreparePlugin,
		).toBeUndefined();
	});
});

describe("loadPlugin", () => {
	it("passes through a valid Plugin object unchanged", async () => {
		const plugin = makePlugin("@elizaos/plugin-object");
		await expect(loadPlugin(plugin)).resolves.toBe(plugin);
	});

	it("fails closed for a string reference when no resolver is injected", async () => {
		await expect(
			loadPlugin("@elizaos/plugin-missing-resolver"),
		).resolves.toBeNull();
	});

	it("resolves a string reference through the injected resolver", async () => {
		const resolved = makePlugin("@elizaos/plugin-resolved");
		const resolver: PluginResolver = {
			resolve: vi.fn(async () => resolved),
		};

		await expect(
			loadPlugin("@elizaos/plugin-resolved", resolver),
		).resolves.toBe(resolved);
		expect(resolver.resolve).toHaveBeenCalledWith("@elizaos/plugin-resolved");
	});

	it("returns null when the resolver yields nothing", async () => {
		const resolver: PluginResolver = { resolve: vi.fn(async () => null) };
		await expect(
			loadPlugin("@elizaos/plugin-none", resolver),
		).resolves.toBeNull();
	});

	it("rejects a resolver result that is not a valid plugin", async () => {
		const resolver: PluginResolver = {
			resolve: vi.fn(async () => ({ notAPlugin: true }) as unknown as Plugin),
		};
		await expect(
			loadPlugin("@elizaos/plugin-invalid", resolver),
		).resolves.toBeNull();
	});
});

describe("resolvePlugins", () => {
	it("routes every string reference through the injected resolver", async () => {
		const sql = makePlugin("@elizaos/plugin-sql");
		const bootstrap = makePlugin("@elizaos/plugin-bootstrap");
		const byName = new Map([
			["@elizaos/plugin-sql", sql],
			["@elizaos/plugin-bootstrap", bootstrap],
		]);
		const resolver: PluginResolver = {
			resolve: vi.fn(async (name) => byName.get(name) ?? null),
		};

		const resolved = await resolvePlugins(
			["@elizaos/plugin-sql", "@elizaos/plugin-bootstrap"],
			false,
			resolver,
		);

		const names = resolved.map((p) => p.name);
		expect(names).toContain("@elizaos/plugin-sql");
		expect(names).toContain("@elizaos/plugin-bootstrap");
		expect(resolver.resolve).toHaveBeenCalledTimes(2);
	});

	it("skips string references (does not install) when no resolver is injected", async () => {
		const objectPlugin = makePlugin("@elizaos/plugin-inline");
		const resolved = await resolvePlugins([
			"@elizaos/plugin-string-only",
			objectPlugin,
		]);

		const names = resolved.map((p) => p.name);
		expect(names).toEqual(["@elizaos/plugin-inline"]);
		expect(names).not.toContain("@elizaos/plugin-string-only");
	});

	it("mixes injected object plugins with resolver-resolved names", async () => {
		const inline = makePlugin("@elizaos/plugin-inline2");
		const resolvedByName = makePlugin("@elizaos/plugin-model");
		const resolver: PluginResolver = {
			resolve: vi.fn(async (name) =>
				name === "@elizaos/plugin-model" ? resolvedByName : null,
			),
		};

		const resolved = await resolvePlugins(
			[inline, "@elizaos/plugin-model"],
			false,
			resolver,
		);

		const names = resolved.map((p) => p.name);
		expect(names).toContain("@elizaos/plugin-inline2");
		expect(names).toContain("@elizaos/plugin-model");
	});
});
