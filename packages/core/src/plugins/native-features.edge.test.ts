/**
 * Tests for native-features.edge — workerd policy for core native features.
 */
import { describe, expect, it } from "vitest";
import {
	getNativeRuntimeFeaturePlugin,
	nativeRuntimeFeatureDefaults,
	nativeRuntimeFeaturePluginNames,
	resolveNativeRuntimeFeatureFromPluginName,
	resolveNativeRuntimeFeatureFromServiceType,
} from "./native-features.edge.ts";

describe("native-features.edge", () => {
	it("exports nativeRuntimeFeatureDefaults with all false", () => {
		expect(nativeRuntimeFeatureDefaults).toEqual({
			documents: false,
			relationships: false,
			trajectories: false,
			advancedPlanning: false,
			advancedMemory: false,
		});
	});

	it("exports nativeRuntimeFeaturePluginNames mapping", () => {
		expect(nativeRuntimeFeaturePluginNames).toEqual({
			documents: "documents",
			relationships: "relationships",
			trajectories: "trajectories",
			advancedPlanning: "advanced-planning",
			advancedMemory: "advanced-memory",
		});
	});

	it("getNativeRuntimeFeaturePlugin throws for any feature", () => {
		for (const feature of Object.keys(nativeRuntimeFeatureDefaults) as Array<
			keyof typeof nativeRuntimeFeatureDefaults
		>) {
			expect(() => getNativeRuntimeFeaturePlugin(feature)).toThrow(
				"requires a dedicated runtime host",
			);
		}
	});

	it("resolveNativeRuntimeFeatureFromPluginName resolves known plugin names", () => {
		expect(resolveNativeRuntimeFeatureFromPluginName("documents")).toBe(
			"documents",
		);
		expect(resolveNativeRuntimeFeatureFromPluginName("relationships")).toBe(
			"relationships",
		);
		expect(resolveNativeRuntimeFeatureFromPluginName("trajectories")).toBe(
			"trajectories",
		);
		expect(resolveNativeRuntimeFeatureFromPluginName("advanced-planning")).toBe(
			"advancedPlanning",
		);
		expect(resolveNativeRuntimeFeatureFromPluginName("advanced-memory")).toBe(
			"advancedMemory",
		);
	});

	it("resolveNativeRuntimeFeatureFromPluginName returns null for unknown or empty", () => {
		expect(resolveNativeRuntimeFeatureFromPluginName(null)).toBeNull();
		expect(resolveNativeRuntimeFeatureFromPluginName(undefined)).toBeNull();
		expect(resolveNativeRuntimeFeatureFromPluginName("")).toBeNull();
		expect(resolveNativeRuntimeFeatureFromPluginName("unknown")).toBeNull();
		expect(resolveNativeRuntimeFeatureFromPluginName("Documents")).toBeNull();
	});

	it("resolveNativeRuntimeFeatureFromServiceType always returns null", () => {
		expect(resolveNativeRuntimeFeatureFromServiceType("documents")).toBeNull();
		expect(resolveNativeRuntimeFeatureFromServiceType("")).toBeNull();
		expect(resolveNativeRuntimeFeatureFromServiceType("anything")).toBeNull();
	});
});
