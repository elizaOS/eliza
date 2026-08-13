/**
 * Passive-connector gate for LifeOps deployments.
 *
 * A runtime is passive when a loaded plugin declares the typed
 * `passiveConnectorsByDefault` capability (the LifeOps personal-assistant
 * plugin does): connectors ingest inbound messages into memory but do not
 * auto-reply, because the LifeOps pipeline drives responses instead. Agents
 * without such a plugin default to active-reply mode. Core never branches on
 * plugin names — only on the declared capability.
 *
 * Explicit env vars (`ELIZA_LIFEOPS_PASSIVE_CONNECTORS` / `LIFEOPS_PASSIVE_CONNECTORS`)
 * and runtime settings always take precedence over capability detection.
 * Pre-runtime hosts that only know resolved plugin names should call
 * {@link lifeOpsPassiveConnectorsSetting} and apply their own loading policy
 * when it returns undefined.
 */

type SettingsReader = {
	getSetting?: (key: string) => unknown;
	plugins?: Array<{ name: string; passiveConnectorsByDefault?: boolean }>;
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

function hasPassiveConnectorPlugin(
	runtime: SettingsReader | null | undefined,
): boolean {
	return (
		Array.isArray(runtime?.plugins) &&
		runtime.plugins.some((p) => p.passiveConnectorsByDefault === true)
	);
}

/**
 * Resolves only the explicit operator-configured passive-connector setting
 * (runtime setting first, then env). Returns undefined when nothing explicit
 * is configured, so pre-runtime callers can fall back to their own policy.
 */
export function lifeOpsPassiveConnectorsSetting(
	runtime?: SettingsReader | null,
	env: EnvLike = defaultEnv(),
): boolean | undefined {
	const value = readFirstSetting(runtime, env);
	if (value === undefined) {
		return undefined;
	}
	return !isExplicitFalse(value);
}

/**
 * Returns whether passive-connector mode is active for this runtime.
 *
 * **Default flip:** prior to this function the default was always `true`
 * (passive). It now defaults from the typed `passiveConnectorsByDefault`
 * plugin capability; agents without such a plugin and without either env var
 * auto-reply on connectors where they previously only ingested.
 */
export function lifeOpsPassiveConnectorsEnabled(
	runtime?: SettingsReader | null,
	env: EnvLike = defaultEnv(),
): boolean {
	const explicit = lifeOpsPassiveConnectorsSetting(runtime, env);
	if (explicit !== undefined) {
		// Explicit setting always wins — higher priority than capability detection.
		return explicit;
	}
	return hasPassiveConnectorPlugin(runtime);
}
