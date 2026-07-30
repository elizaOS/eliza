/**
 * Covers the `NativeRuntimeFeature` registry: that every feature has a matching
 * plugin and name, the plugin-name→feature lookup round-trips, and advancedPlanning
 * /advancedMemory default OFF while documents/relationships/trajectories default
 * ON. Pure registry assertions — no runtime boot.
 */
import { describe, expect, it } from "vitest";
import {
	advancedActions,
	advancedEvaluators,
	advancedProviders,
} from "../features/advanced-capabilities/index.ts";
import {
	nativeRuntimeFeatureDefaults,
	nativeRuntimeFeaturePluginNames,
	nativeRuntimeFeaturePlugins,
	resolveNativeRuntimeFeatureFromPluginName,
} from "./native-features.ts";

describe("native runtime feature registry (#12092 item 32)", () => {
	const features = Object.keys(nativeRuntimeFeatureDefaults) as Array<
		keyof typeof nativeRuntimeFeatureDefaults
	>;

	it("includes advancedPlanning and advancedMemory, defaulting OFF", () => {
		expect(nativeRuntimeFeatureDefaults.advancedPlanning).toBe(false);
		expect(nativeRuntimeFeatureDefaults.advancedMemory).toBe(false);
		// the always-on core features remain default ON
		expect(nativeRuntimeFeatureDefaults.documents).toBe(true);
		expect(nativeRuntimeFeatureDefaults.relationships).toBe(true);
		expect(nativeRuntimeFeatureDefaults.trajectories).toBe(true);
	});

	it("has a plugin + name for every feature, and no undefined entries", () => {
		for (const feature of features) {
			const plugin = nativeRuntimeFeaturePlugins[feature];
			expect(plugin, `plugin for ${feature}`).toBeDefined();
			expect(typeof plugin.name).toBe("string");
			expect(nativeRuntimeFeaturePluginNames[feature]).toBe(plugin.name);
		}
	});

	it("maps each plugin name back to its feature (round-trip)", () => {
		for (const feature of features) {
			const name = nativeRuntimeFeaturePluginNames[feature];
			expect(resolveNativeRuntimeFeatureFromPluginName(name)).toBe(feature);
		}
	});

	it("gives relationship components one owner", () => {
		const relationships = nativeRuntimeFeaturePlugins.relationships;
		const relationshipActionNames = new Set(
			relationships.actions?.map((action) => action.name) ?? [],
		);
		const relationshipProviderNames = new Set(
			relationships.providers?.map((provider) => provider.name) ?? [],
		);
		const relationshipEvaluatorNames = new Set(
			relationships.evaluators?.map((evaluator) => evaluator.name) ?? [],
		);

		expect(
			advancedActions.filter((action) =>
				relationshipActionNames.has(action.name),
			),
		).toEqual([]);
		expect(
			advancedProviders.filter((provider) =>
				relationshipProviderNames.has(provider.name),
			),
		).toEqual([]);
		expect(
			advancedEvaluators.filter((evaluator) =>
				relationshipEvaluatorNames.has(evaluator.name),
			),
		).toEqual([]);
	});
});
