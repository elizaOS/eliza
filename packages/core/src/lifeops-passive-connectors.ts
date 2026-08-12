/**
 * Passive-connector gate for LifeOps deployments.
 *
 * When `plugin-personal-assistant` is loaded the runtime operates in passive
 * mode: connectors ingest inbound messages into memory but do not auto-reply
 * (the LifeOps pipeline drives responses instead). Standalone agents that do
 * not load that plugin default to active-reply mode.
 *
 * Explicit env vars (`ELIZA_LIFEOPS_PASSIVE_CONNECTORS` / `LIFEOPS_PASSIVE_CONNECTORS`)
 * and runtime settings always take precedence over plugin-presence detection.
 * Callers that run before `AgentRuntime` construction must supply the plugin
 * set they have resolved from configuration. An absent runtime or plugin list
 * means no LifeOps deployment was identified and therefore defaults active.
 */

type SettingsReader = {
	getSetting?: (key: string) => unknown;
	plugins?: Array<{ name: string }>;
};

type EnvLike = Record<string, string | undefined>;

const PASSIVE_CONNECTOR_SETTING_KEYS = [
	"ELIZA_LIFEOPS_PASSIVE_CONNECTORS",
	"LIFEOPS_PASSIVE_CONNECTORS",
] as const;

const LIFEOPS_PLUGIN_NAME = "@elizaos/plugin-personal-assistant";

function readFirstSetting(
	runtime: SettingsReader | null | undefined,
	env: EnvLike,
): unknown {
	for (const key of PASSIVE_CONNECTOR_SETTING_KEYS) {
		const runtimeValue = runtime?.getSetting?.(key);
		if (runtimeValue !== undefined && runtimeValue !== null) {
			return runtimeValue;
		}
		const envValue = env[key];
		if (envValue !== undefined && envValue !== null) {
			return envValue;
		}
	}
	return undefined;
}

function defaultEnv(): EnvLike {
	const globalWithProcess = globalThis as {
		process?: { env?: EnvLike };
	};
	return globalWithProcess.process?.env ?? {};
}

function isExplicitFalse(value: unknown): boolean {
	if (value === false || value === 0) {
		return true;
	}
	if (typeof value !== "string") {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "0" ||
		normalized === "false" ||
		normalized === "off" ||
		normalized === "no" ||
		normalized === "disabled"
	);
}

function isLifeOpsPluginLoaded(
	runtime: SettingsReader | null | undefined,
): boolean {
	return (
		Array.isArray(runtime?.plugins) &&
		runtime.plugins.some((p) => p.name === LIFEOPS_PLUGIN_NAME)
	);
}

/**
 * Returns whether LifeOps passive-connector mode is active for this runtime.
 *
 * **Default flip:** prior to this function the default was always `true` (passive).
 * It is now `false` for agents that do not load `plugin-personal-assistant` and
 * do not set either env var. Any existing deployment without that plugin will
 * begin auto-replying on connectors where it previously only ingested.
 */
export function lifeOpsPassiveConnectorsEnabled(
	runtime?: SettingsReader | null,
	env: EnvLike = defaultEnv(),
): boolean {
	const value = readFirstSetting(runtime, env);
	if (value !== undefined) {
		// Explicit setting always wins — higher priority than plugin detection.
		return !isExplicitFalse(value);
	}
	return isLifeOpsPluginLoaded(runtime);
}
