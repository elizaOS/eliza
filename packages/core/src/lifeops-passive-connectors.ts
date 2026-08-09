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
		runtime.plugins.some((plugin) => plugin.name === LIFEOPS_PLUGIN_NAME)
	);
}

/**
 * Resolves whether LifeOps passive connectors are enabled.
 *
 * WHY: passive mode belongs to LifeOps, where connector plugins ingest inbound
 * messages and the personal-assistant pipeline decides what to do later.
 * Standalone agents do not have that pipeline, so defaulting them to passive
 * makes Discord/Telegram/iMessage/etc appear connected but silent.
 *
 * Explicit runtime/env settings still win for operators. A `null` runtime is the
 * pre-runtime signal used by standalone bootstrap checks, where plugin presence
 * cannot be known yet; keep that conservative passive-on default so LifeOps
 * deployments do not start duplicate connector loops before the runtime exists.
 */
export function lifeOpsPassiveConnectorsEnabled(
	runtime?: SettingsReader | null,
	env: EnvLike = defaultEnv(),
): boolean {
	const value = readFirstSetting(runtime, env);
	if (value !== undefined) {
		return !isExplicitFalse(value);
	}
	if (runtime === null) {
		return true;
	}
	return isLifeOpsPluginLoaded(runtime);
}
