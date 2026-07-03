import { describe, expect, it } from "vitest";

import {
	nativeRuntimeFeatureDefaults,
	nativeRuntimeFeaturePluginNames,
	nativeRuntimeFeaturePlugins,
	resolveNativeRuntimeFeatureFromPluginName,
} from "./native-features.ts";

// #12092 item 32: advancedPlanning/advancedMemory were bespoke if-blocks in
// `_initializeCore`; they now live in the NativeRuntimeFeature registry so the
// boot loop iterates ONE registry. These assert the registry is complete and
// self-consistent (which is what makes the generic loop pick the features up),
// and that the two folded-in features default OFF (flag is an explicit override).
describe("native runtime feature registry (#12092 item 32)", () => {
	const features = Object.keys(
		nativeRuntimeFeatureDefaults,
	) as Array<keyof typeof nativeRuntimeFeatureDefaults>;

	it("includes advancedPlanning and advancedMemory, defaulting OFF", () => {
		expect(nativeRuntimeFeatureDefaults.advancedPlanning).toBe(false);
		expect(nativeRuntimeFeatureDefaults.advancedMemory).toBe(false);
		// the always-on core features are unchanged
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
});
