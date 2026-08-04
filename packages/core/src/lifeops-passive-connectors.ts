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
	// No explicit setting — enable passive mode only when the LifeOps plugin is
	// actually loaded. Standalone agent harnesses (no plugin-personal-assistant)
	// default to active-reply mode so they work without any env var.
	return isLifeOpsPluginLoaded(runtime);
}
