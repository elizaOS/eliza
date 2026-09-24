/** Resolves runtime environment aliases from explicit input or host-installed process configuration.
 * Browser bootstrap mirrors belong to the host; reads here never initialize or
 * overwrite its configuration store.
 */
import { peekAmbientSingleton } from "./ambient-context.js";
import { resolveEnvAlias } from "./utils/env-alias.js";

interface AppBootConfig {
	envAliases?: readonly (readonly [string, string])[];
	[key: string]: unknown;
}

interface BootConfigStore {
	current: AppBootConfig;
}

const DEFAULT_BOOT_CONFIG: AppBootConfig = {};
const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
function getBootConfig(): AppBootConfig {
	const store = peekAmbientSingleton<BootConfigStore>(BOOT_CONFIG_STORE_KEY);
	return store ? store.current : DEFAULT_BOOT_CONFIG;
}

export function getBootConfigEnvAliases():
	| readonly (readonly [string, string])[]
	| undefined {
	return getBootConfig().envAliases;
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
	env: Record<string, string | undefined> | null = process.env,
): string | undefined {
	return resolveEnvAlias(key, aliases, env);
}
