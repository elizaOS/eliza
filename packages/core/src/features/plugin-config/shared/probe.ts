/**
 * Shared probe helper.
 *
 * Single source of truth for "given a plugin name, what's the required vs.
 * optional vs. present vs. missing secret split?". Used by the
 * PROBE_PLUGIN_CONFIG_REQUIREMENTS action AND by the
 * `plugin-configuration-completeness` planner provider so the two surfaces
 * cannot drift.
 */

import type { IAgentRuntime } from "../../../types/index.ts";
import {
	SECRETS_SERVICE_TYPE,
	type SecretsService,
} from "../../secrets/services/secrets.ts";
import {
	PLUGIN_MANIFEST_PROVIDER_SERVICE,
	type PluginConfigManifest,
	type PluginManifestProvider,
	type ProbePluginConfigResult,
} from "../types.ts";

export function getManifestProvider(
	runtime: IAgentRuntime,
): PluginManifestProvider | null {
	return runtime.getService(
		PLUGIN_MANIFEST_PROVIDER_SERVICE,
	) as unknown as PluginManifestProvider | null;
}

export function getSecretsService(
	runtime: IAgentRuntime,
): SecretsService | null {
	return runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);
}

export interface ProbeOptions {
	/** Pre-resolved manifest. Avoids a duplicate provider lookup. */
	manifest?: PluginConfigManifest | null;
}

/**
 * Resolve the manifest for `pluginName` and check global-level secret presence
 * via the SecretsService. Returns null when the manifest can't be found.
 */
export async function probePluginConfig(
	runtime: IAgentRuntime,
	pluginName: string,
	options: ProbeOptions = {},
): Promise<ProbePluginConfigResult | null> {
	const manifest =
		options.manifest ?? getManifestProvider(runtime)?.getManifest(pluginName);
	if (!manifest) return null;

	const secrets = getSecretsService(runtime);
	const required = [...manifest.requiredSecrets];
	const optional = [...manifest.optionalSecrets];
	const allKeys = [...new Set([...required, ...optional])];

	const present: string[] = [];
	if (secrets) {
		for (const key of allKeys) {
			const exists = await secrets.exists(key, {
				level: "global",
				agentId: runtime.agentId,
			});
			if (exists) present.push(key);
		}
	}

	const missing = required.filter((key) => !present.includes(key));

	return {
		pluginName: manifest.name,
		required,
		optional,
		present,
		missing,
		ready: missing.length === 0,
	};
}
