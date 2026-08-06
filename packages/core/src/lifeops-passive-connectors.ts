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
 * Passing `null` as the runtime is the pre-runtime signal (plugin list not yet
 * available); it conservatively enables passive mode so the standalone Telegram
 * polling bot does not start for LifeOps deployments before the runtime exists.
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

export function lifeOpsPassiveConnectorsEnabled(
	runtime?: SettingsReader | null,
	env: EnvLike = defaultEnv(),
): boolean {
	const value = readFirstSetting(runtime, env);
	if (value !== undefined) {
		// Explicit setting always wins.
		return !isExplicitFalse(value);
	}
	// null is the explicit pre-runtime signal from callers like
	// shouldStartTelegramStandaloneBot() that run before any runtime exists.
	// Plugin-presence detection is meaningless here, so keep the conservative
	// passive-on default to avoid accidentally starting connectors for LifeOps
	// deployments before the plugin list is known.
	if (runtime === null) {
		return true;
	}
	// No explicit setting and a real (or absent) runtime — enable passive mode
	// only when the LifeOps plugin is actually loaded. Standalone agent harnesses
	// (no plugin-personal-assistant) default to active-reply mode.
	return isLifeOpsPluginLoaded(runtime);
}
