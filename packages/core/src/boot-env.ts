interface AppBootConfig {
	envAliases?: readonly (readonly [string, string])[];
	[key: string]: unknown;
}

interface BootConfigStore {
	current: AppBootConfig;
}

const DEFAULT_BOOT_CONFIG: AppBootConfig = {};
const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
const BOOT_CONFIG_WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";

type GlobalConfigSlot = Record<PropertyKey, unknown> & {
	[K in typeof BOOT_CONFIG_WINDOW_KEY]?: AppBootConfig;
};

const mirroredBrandKeys = new Set<string>();
const mirroredElizaKeys = new Set<string>();

function getGlobalSlot(): GlobalConfigSlot {
	return globalThis as GlobalConfigSlot;
}

function getBootConfigStore(): BootConfigStore {
	const globalObject = getGlobalSlot();
	const mirroredWindowConfig = globalObject[BOOT_CONFIG_WINDOW_KEY];
	if (mirroredWindowConfig) {
		const mirroredStore: BootConfigStore = { current: mirroredWindowConfig };
		globalObject[BOOT_CONFIG_STORE_KEY] = mirroredStore;
		return mirroredStore;
	}

	const existing = globalObject[BOOT_CONFIG_STORE_KEY];
	if (
		existing &&
		typeof existing === "object" &&
		"current" in (existing as Record<string, unknown>)
	) {
		return existing as BootConfigStore;
	}

	const store: BootConfigStore = { current: DEFAULT_BOOT_CONFIG };
	globalObject[BOOT_CONFIG_STORE_KEY] = store;
	globalObject[BOOT_CONFIG_WINDOW_KEY] = store.current;
	return store;
}

function getBootConfig(): AppBootConfig {
	return getBootConfigStore().current;
}

function getProcessEnv(): Record<string, string | undefined> | null {
	try {
		const p = (globalThis as Record<string, unknown>).process as
			| { env?: Record<string, string | undefined> }
			| undefined;
		return p?.env ?? null;
	} catch {
		return null;
	}
}

export function syncBrandEnvToEliza(
	aliases: readonly (readonly [string, string])[],
): void {
	const env = getProcessEnv();
	if (!env) return;
	for (const [brandKey, elizaKey] of aliases) {
		const value = env[brandKey];
		if (typeof value === "string") {
			env[elizaKey] = value;
			mirroredElizaKeys.add(elizaKey);
		} else if (mirroredElizaKeys.has(elizaKey)) {
			delete env[elizaKey];
			mirroredElizaKeys.delete(elizaKey);
		}
	}
}

export function syncElizaEnvToBrand(
	aliases: readonly (readonly [string, string])[],
): void {
	const env = getProcessEnv();
	if (!env) return;
	for (const [brandKey, elizaKey] of aliases) {
		const value = env[elizaKey];
		if (typeof value === "string") {
			env[brandKey] = value;
			mirroredBrandKeys.add(brandKey);
		} else if (mirroredBrandKeys.has(brandKey)) {
			delete env[brandKey];
			mirroredBrandKeys.delete(brandKey);
		}
	}
}

export function syncAppEnvToEliza(): void {
	const aliases = getBootConfig().envAliases;
	if (aliases) syncBrandEnvToEliza(aliases);
}

export function syncElizaEnvAliases(): void {
	const aliases = getBootConfig().envAliases;
	if (aliases) syncElizaEnvToBrand(aliases);
}
