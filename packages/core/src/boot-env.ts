/**
 * App boot configuration plus the non-mutating brand<->ELIZA env-alias reader,
 * shared across every bundled copy of `@elizaos/core`. The boot-config store is
 * a write-once singleton kept on the shared global slot through core's
 * ambient-context accessor so core/shared/ui bundles observe one instance; an
 * established store always wins over the pre-boot `__ELIZAOS_APP_BOOT_CONFIG__`
 * window mirror that the HTML bootstrap / Electrobun preload seeds before any
 * bundle loads.
 *
 * `resolveAliasedEnvValue` resolves a value for either name in a brand<->ELIZA
 * alias pair WITHOUT writing to `process.env`: it consults the immutable
 * BootConfig alias table so a white-label distribution's `<PREFIX>_*` variable
 * surfaces without materializing the `ELIZA_*` mirror. This replaced the old
 * `process.env` alias-sync mutation entirely (#12251 / #13423).
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

export function getBootConfigEnvAliases():
	| readonly (readonly [string, string])[]
	| undefined {
	return getBootConfig().envAliases;
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

/**
 * Build a bidirectional key -> alias-partners lookup from the alias pair table.
 *
 * Each `[brandKey, elizaKey]` pair contributes both directions so a lookup of
 * either name yields its partner(s). A single key can participate in more than
 * one pair (kept as a list) so no alias is silently dropped.
 */
function buildAliasPartnerMap(
	aliases: readonly (readonly [string, string])[],
): Map<string, string[]> {
	const map = new Map<string, string[]>();
	const link = (from: string, to: string): void => {
		if (from === to) return;
		const existing = map.get(from);
		if (existing) {
			if (!existing.includes(to)) existing.push(to);
		} else {
			map.set(from, [to]);
		}
	};
	for (const [brandKey, elizaKey] of aliases) {
		link(brandKey, elizaKey);
		link(elizaKey, brandKey);
	}
	return map;
}

/**
 * An env value counts as "present" only when it is a non-empty (after trim)
 * string, matching the shared `normalizeEnvValue` / `readEnv` contract (empty /
 * whitespace-only = unset). Treating a blank direct value as present would let
 * `ELIZA_API_TOKEN=""` shadow a real `ACME_API_TOKEN`, resolving a set alias as
 * missing.
 */
function presentEnvValue(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim() ? value : undefined;
}

/**
 * Additive, NON-mutating alias-aware env reader (arch-audit #12251).
 *
 * Resolves an env value for `key` by consulting the brand<->eliza alias table
 * WITHOUT writing anything to `process.env`. The requested key wins when it is
 * present (non-empty); a blank/whitespace value is treated as absent so a real
 * alias partner still surfaces. If the key is absent, the first present alias
 * partner (in alias-table order) is returned. This is the sole brand<->eliza
 * env-resolution path: it replaced the old `process.env` alias-sync mutation
 * (#13423), so a `<PREFIX>_*` value resolves for either name with nothing ever
 * written back to the environment.
 *
 * @param key       the env key a caller wants to read
 * @param aliases   alias pair table; defaults to the immutable BootConfig list
 * @param env       env source; defaults to the live `process.env`
 * @returns the resolved value, or `undefined` when neither key nor an alias
 *          partner is present
 */
export function resolveAliasedEnvValue(
	key: string,
	aliases: readonly (readonly [string, string])[] | undefined = getBootConfig()
		.envAliases,
	env: Record<string, string | undefined> | null = getProcessEnv(),
): string | undefined {
	if (!env) return undefined;

	// The exact key takes precedence when it carries a real value — but a blank
	// value must NOT shadow a present alias partner (see presentEnvValue).
	const direct = presentEnvValue(env[key]);
	if (direct !== undefined) return direct;

	if (!aliases || aliases.length === 0) return undefined;

	const partners = buildAliasPartnerMap(aliases).get(key);
	if (!partners) return undefined;

	for (const partner of partners) {
		const value = presentEnvValue(env[partner]);
		if (value !== undefined) return value;
	}
	return undefined;
}
