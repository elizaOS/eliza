/**
 * Workerd policy for core-compiled native features. These bundles contain
 * dedicated-host concerns, so Shared agents start with every native feature
 * disabled and fail explicitly if one is requested through runtime flags.
 */

import type { Plugin } from "../types/plugin.ts";

export type NativeRuntimeFeature =
	| "documents"
	| "relationships"
	| "trajectories"
	| "advancedPlanning"
	| "advancedMemory";

export const nativeRuntimeFeatureDefaults: Record<
	NativeRuntimeFeature,
	boolean
> = {
	documents: false,
	relationships: false,
	trajectories: false,
	advancedPlanning: false,
	advancedMemory: false,
};

export const nativeRuntimeFeaturePluginNames: Record<
	NativeRuntimeFeature,
	string
> = {
	documents: "documents",
	relationships: "relationships",
	trajectories: "trajectories",
	advancedPlanning: "advanced-planning",
	advancedMemory: "advanced-memory",
};

export function getNativeRuntimeFeaturePlugin(
	feature: NativeRuntimeFeature,
): Plugin {
	throw new Error(
		`Core native feature ${feature} requires a dedicated runtime host`,
	);
}

export function resolveNativeRuntimeFeatureFromPluginName(
	pluginName: string | null | undefined,
): NativeRuntimeFeature | null {
	if (!pluginName) return null;
	for (const feature of Object.keys(
		nativeRuntimeFeaturePluginNames,
	) as NativeRuntimeFeature[]) {
		if (nativeRuntimeFeaturePluginNames[feature] === pluginName) return feature;
	}
	return null;
}

export function resolveNativeRuntimeFeatureFromServiceType(
	_serviceType: string,
): NativeRuntimeFeature | null {
	return null;
}
