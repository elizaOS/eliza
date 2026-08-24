/**
 * Unit tests for the runtime half of the plugin-manager shared type surface:
 * the `PluginManagerServiceType` service-name constants and the `PluginStatus`
 * lifecycle enum. Fully deterministic — no runtime, database, or live model in
 * play. The suites drive the real exported objects and reproduce the
 * equality-partition counting pattern that
 * `actions/plugin-handlers/runtime-state.ts` performs over tracked plugin
 * states, so the invariants asserted here are ones consumers actually rely on.
 */
import { describe, expect, it } from "vitest";
import { PluginManagerServiceType, PluginStatus } from "./types.ts";

const ALL_STATUSES = [
	PluginStatus.READY,
	PluginStatus.LOADED,
	PluginStatus.ERROR,
	PluginStatus.UNLOADED,
] as const;

describe("plugin-manager types → PluginStatus lifecycle enum", () => {
	it("closes the lifecycle over exactly four distinct non-empty states", () => {
		const entries = Object.entries(PluginStatus);
		expect(entries.map(([name]) => name).sort()).toEqual([
			"ERROR",
			"LOADED",
			"READY",
			"UNLOADED",
		]);
		for (const [name, value] of entries) {
			expect(typeof value).toBe("string");
			expect(
				value.length,
				`${name} must map to a non-empty string`,
			).toBeGreaterThan(0);
		}
		expect(new Set(entries.map(([, value]) => value)).size).toBe(
			ALL_STATUSES.length,
		);
	});

	it("keeps the runtime-state four-bucket count exhaustive and disjoint", () => {
		// Mirrors the counting loop in actions/plugin-handlers/runtime-state.ts:
		// every tracked plugin must land in exactly one of the four === buckets,
		// so reported loaded/ready/unloaded/error counts always sum to the total.
		const tracked: PluginStatus[] = [
			PluginStatus.LOADED,
			PluginStatus.READY,
			PluginStatus.LOADED,
			PluginStatus.ERROR,
			PluginStatus.UNLOADED,
			PluginStatus.READY,
			PluginStatus.LOADED,
		];

		const counted = ALL_STATUSES.reduce(
			(sum, status) =>
				sum + tracked.filter((candidate) => candidate === status).length,
			0,
		);
		expect(counted).toBe(tracked.length);

		const byStatus = new Map(
			ALL_STATUSES.map((status) => [
				status,
				tracked.filter((candidate) => candidate === status).length,
			]),
		);
		expect(byStatus.get(PluginStatus.LOADED)).toBe(3);
		expect(byStatus.get(PluginStatus.READY)).toBe(2);
		expect(byStatus.get(PluginStatus.ERROR)).toBe(1);
		expect(byStatus.get(PluginStatus.UNLOADED)).toBe(1);
	});

	it("survives a JSON persistence round-trip with discrimination intact", () => {
		const stored = JSON.parse(
			JSON.stringify({
				id: "00000000-0000-0000-0000-00000000c0de",
				name: "plugin-sql",
				status: PluginStatus.LOADED,
			}),
		) as { id: string; name: string; status: PluginStatus };

		expect(stored.status).toBe(PluginStatus.LOADED);
		expect(stored.status === PluginStatus.ERROR).toBe(false);
	});

	it("deduplicates as a plain string inside consumer tracking sets", () => {
		const seen = new Set<string>([
			PluginStatus.READY,
			PluginStatus.READY,
			PluginStatus.LOADED,
		]);
		expect(seen.size).toBe(2);
		expect(seen.has(PluginStatus.READY)).toBe(true);
		expect(seen.has(PluginStatus.UNLOADED)).toBe(false);
	});
});

describe("plugin-manager types → PluginManagerServiceType constants", () => {
	it("names exactly the four plugin-manager services without collisions", () => {
		const entries = Object.entries(PluginManagerServiceType);
		expect(entries.map(([key]) => key).sort()).toEqual([
			"CORE_MANAGER",
			"PLUGIN_CONFIGURATION",
			"PLUGIN_MANAGER",
			"REGISTRY",
		]);
		const names = entries.map(([, value]) => value);
		for (const name of names) {
			expect(
				name.length,
				`${name} must be a non-empty service name`,
			).toBeGreaterThan(0);
		}
		expect(new Set(names).size).toBe(names.length);
	});

	it("keeps service lookups unambiguous across the four namespaces", () => {
		// The registration/lookup seam every consumer relies on: services are
		// stored under these constants and retrieved with the same constant.
		// A collision between any two constants would silently overwrite the
		// earlier registration, so the map must hold all four at once.
		const services = new Map<string, string>();
		services.set(PluginManagerServiceType.PLUGIN_MANAGER, "manager");
		services.set(
			PluginManagerServiceType.PLUGIN_CONFIGURATION,
			"configuration",
		);
		services.set(PluginManagerServiceType.REGISTRY, "registry");
		services.set(PluginManagerServiceType.CORE_MANAGER, "core");

		expect(services.size).toBe(4);
		expect(services.get(PluginManagerServiceType.PLUGIN_MANAGER)).toBe(
			"manager",
		);
		expect(services.get(PluginManagerServiceType.PLUGIN_CONFIGURATION)).toBe(
			"configuration",
		);
		expect(services.get(PluginManagerServiceType.REGISTRY)).toBe("registry");
		expect(services.get(PluginManagerServiceType.CORE_MANAGER)).toBe("core");
	});
});
