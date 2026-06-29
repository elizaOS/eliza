/** Canonical setting resolver: per-agent runtime setting first, then env. */

import { type ReadEnvOptions, readEnv } from "./read-env.js";

/**
 * Minimal structural shape of a runtime that can resolve a setting. Kept local
 * (rather than importing `IAgentRuntime`) so this helper stays browser/edge-safe
 * and free of the runtime type graph.
 */
export interface SettingReader {
	getSetting(key: string): string | boolean | number | null;
}

export type ResolveSettingOptions = ReadEnvOptions;

/**
 * Resolve a configuration value the way single-tenant / headless plugins want
 * it: the per-agent runtime setting first, then `process.env` as a deployment
 * fallback, then an optional default.
 *
 * **WHY a shared helper:** core `AgentRuntime.getSetting()` is intentionally
 * per-agent and does **not** read `process.env` — host/infra secrets must not
 * leak into every agent sharing a multi-tenant process. Plugins that still want
 * a dotenv fallback (single-tenant, headless, local dev) each reimplemented the
 * same runtime→env chain (plugin-x, plugin-elizacloud, plugin-embeddings,
 * plugin-edge-tts, plugin-elevenlabs, …). This is the one canonical
 * implementation they should delegate to instead. It does not change
 * `getSetting()` semantics — multi-tenant hosts that never call it are
 * unaffected.
 *
 * Runtime values are coerced to string. The env fallback uses {@link readEnv}
 * semantics (trimmed; empty strings treated as unset).
 *
 * @param runtime - Runtime to read the per-agent setting from (may be null)
 * @param key - Setting / environment variable name
 * @param options - `defaultValue` and/or an explicit `env` record
 * @returns The resolved string, `options.defaultValue`, or `undefined`
 */
export function resolveSetting(
	runtime: SettingReader | null | undefined,
	key: string,
	options: ResolveSettingOptions = {},
): string | undefined {
	const fromRuntime = runtime?.getSetting(key);
	if (fromRuntime !== undefined && fromRuntime !== null) {
		return String(fromRuntime);
	}
	return readEnv(key, options);
}
