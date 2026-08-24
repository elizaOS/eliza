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

	it("throws with the exact dedicated-host message for every feature", () => {
		const features = Object.keys(nativeRuntimeFeatureDefaults) as Array<
			keyof typeof nativeRuntimeFeatureDefaults
		>;
		for (const feature of features) {
			expect(() => getNativeRuntimeFeaturePlugin(feature)).toThrow(
				new RegExp(
					`^Core native feature ${feature} requires a dedicated runtime host$`,
				),
			);
		}
	});

	it("maps every remaining plugin name back to its feature", () => {
		expect(resolveNativeRuntimeFeatureFromPluginName("relationships")).toBe(
			"relationships",
		);
		expect(resolveNativeRuntimeFeatureFromPluginName("trajectories")).toBe(
			"trajectories",
		);
		expect(resolveNativeRuntimeFeatureFromPluginName("advanced-memory")).toBe(
			"advancedMemory",
		);
	});

	it("treats undefined and empty plugin names as unresolved", () => {
		expect(resolveNativeRuntimeFeatureFromPluginName(undefined)).toBeNull();
		expect(resolveNativeRuntimeFeatureFromPluginName("")).toBeNull();
	});

	it("matches plugin names exactly, case-sensitively, without trimming", () => {
		expect(resolveNativeRuntimeFeatureFromPluginName("Documents")).toBeNull();
		expect(
			resolveNativeRuntimeFeatureFromPluginName("advancedPlanning"),
		).toBeNull();
		expect(
			resolveNativeRuntimeFeatureFromPluginName(" advanced-memory "),
		).toBeNull();
		expect(
			resolveNativeRuntimeFeatureFromPluginName("advanced-memory-extra"),
		).toBeNull();
	});

	it("does not resolve inherited object keys as plugin names", () => {
		expect(resolveNativeRuntimeFeatureFromPluginName("toString")).toBeNull();
	});

	it("declares the complete feature-to-plugin-name mapping", () => {
		expect(nativeRuntimeFeaturePluginNames).toEqual({
			documents: "documents",
			relationships: "relationships",
			trajectories: "trajectories",
			advancedPlanning: "advanced-planning",
			advancedMemory: "advanced-memory",
		});
	});

	it("ignores every feature name, plugin name, and empty service type", () => {
		const inputs = [
			"",
			...Object.keys(nativeRuntimeFeatureDefaults),
			...Object.values(nativeRuntimeFeaturePluginNames),
		];
		for (const serviceType of inputs) {
			expect(
				resolveNativeRuntimeFeatureFromServiceType(serviceType),
			).toBeNull();
		}
	});
});
