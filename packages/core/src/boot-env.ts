/**
 * App boot configuration plus env-alias mirroring, shared across every bundled
 * copy of `@elizaos/core`. The boot-config store is a write-once singleton kept
 * on the shared global slot through core's ambient-context accessor so
 * core/shared/ui bundles observe one instance; an established store always wins
 * over the pre-boot `__ELIZAOS_APP_BOOT_CONFIG__` window mirror that the HTML
 * bootstrap / Electrobun preload seeds before any bundle loads.
 *
 * syncBrandEnvToEliza / syncElizaEnvToBrand copy values between branded and
 * ELIZA_ env-key aliases and remember which targets they wrote, so a source key
 * that disappears clears only its own mirrored target and never a value set by
 * hand. The sync* wrappers pull the alias list from the boot config.
 */
import {
	peekAmbientSingleton,
	setAmbientSingleton,
} from "./ambient-context.js";

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
	// The store singleton lives on the shared global slot so every bundled copy
	// of `@elizaos/core` observes the same instance. Read/write it through the
	// core-owned ambient-context accessor rather than hand-rolling the
	// `globalThis[Symbol.for(...)]` access (matches the trajectory/action/app
	// registries consolidated in #12164).
	//
	// An established store always wins. The window-key mirror is only a
	// pre-boot seed (set by the HTML bootstrap / Electrobun preload before any
	// bundle loads) and must never replace a store that already exists —
	// otherwise a stale or partial window value silently clobbers config that
	// setBootConfig already committed, and the store's object identity churns
	// on every read (dropping any store-only state).
	const existing = peekAmbientSingleton<BootConfigStore>(BOOT_CONFIG_STORE_KEY);
	if (existing && typeof existing === "object" && "current" in existing) {
		return existing;
	}

	// No store yet: seed it once. Prefer a cross-bundle window mirror when a
	// bootstrap set it, otherwise fall back to defaults. The slot is written
	// once here and thereafter returned as-is by the branch above.
	const globalObject = getGlobalSlot();
	const mirroredWindowConfig = globalObject[BOOT_CONFIG_WINDOW_KEY];
	const store: BootConfigStore = {
		current: mirroredWindowConfig ?? DEFAULT_BOOT_CONFIG,
	};
	setAmbientSingleton(BOOT_CONFIG_STORE_KEY, store);
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
