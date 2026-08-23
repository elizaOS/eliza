/**
 * Verifies native-runtime feature policy through deterministic pure helpers
 * without initializing an agent runtime.
 */
import { describe, expect, it } from "vitest";
import {
	getNativeRuntimeFeaturePlugin,
	nativeRuntimeFeatureDefaults,
	nativeRuntimeFeaturePluginNames,
	resolveNativeRuntimeFeatureFromPluginName,
	resolveNativeRuntimeFeatureFromServiceType,
} from "../native-features.edge.ts";

describe("native-features.edge", () => {
	it("defaults every native feature to disabled", () => {
		expect(nativeRuntimeFeatureDefaults).toEqual({
			documents: false,
			relationships: false,
			trajectories: false,
			advancedPlanning: false,
			advancedMemory: false,
		});
	});

	it("maps feature names for plugin matching", () => {
		expect(nativeRuntimeFeaturePluginNames.advancedMemory).toBe(
			"advanced-memory",
		);
		expect(nativeRuntimeFeaturePluginNames.documents).toBe("documents");
	});

	it("resolves a feature from its plugin name", () => {
		expect(resolveNativeRuntimeFeatureFromPluginName("advanced-planning")).toBe(
			"advancedPlanning",
		);
		expect(resolveNativeRuntimeFeatureFromPluginName("documents")).toBe(
			"documents",
		);
		expect(resolveNativeRuntimeFeatureFromPluginName("unknown")).toBeNull();
		expect(resolveNativeRuntimeFeatureFromPluginName(null)).toBeNull();
	});

	it("rejects dedicated-host features explicitly", () => {
		expect(() => getNativeRuntimeFeaturePlugin("documents")).toThrow(
			"requires a dedicated runtime host",
		);
	});

	it("resolves no feature from service types on the edge", () => {
		expect(resolveNativeRuntimeFeatureFromServiceType("anything")).toBeNull();
	});
});
