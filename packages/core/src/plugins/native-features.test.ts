/**
 * Exercises reverse lookup across the native runtime feature registry.
 */
import { describe, expect, it } from "vitest";

import {
	nativeRuntimeFeatureDefaults,
	nativeRuntimeFeaturePluginNames,
	resolveNativeRuntimeFeatureFromPluginName,
} from "./native-features.ts";

describe("native runtime feature registry (#12092 item 32)", () => {
	const features = Object.keys(nativeRuntimeFeatureDefaults) as Array<
		keyof typeof nativeRuntimeFeatureDefaults
	>;

	it("maps each plugin name back to its feature (round-trip)", () => {
		for (const feature of features) {
			const name = nativeRuntimeFeaturePluginNames[feature];
			expect(resolveNativeRuntimeFeatureFromPluginName(name)).toBe(feature);
		}
	});
});
