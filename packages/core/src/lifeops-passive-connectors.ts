type SettingsReader = {
	getSetting?: (key: string) => unknown;
};

type EnvLike = Record<string, string | undefined>;

const PASSIVE_CONNECTOR_SETTING_KEYS = [
	"ELIZA_LIFEOPS_PASSIVE_CONNECTORS",
	"LIFEOPS_PASSIVE_CONNECTORS",
] as const;

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

export function lifeOpsPassiveConnectorsEnabled(
	runtime?: SettingsReader | null,
	env: EnvLike = defaultEnv(),
): boolean {
	const value = readFirstSetting(runtime, env);
	return value === undefined ? true : !isExplicitFalse(value);
}
