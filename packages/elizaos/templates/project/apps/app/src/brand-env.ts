/**
 * Per-app ↔ Eliza environment variable aliasing.
 *
 * Lives in apps/app, NOT in packages/app-core. The alias table is passed to
 * the boot config so app-core's generic syncBrandEnvToEliza/syncElizaEnvToBrand
 * helpers can walk it.
 *
 * `buildBrandEnvAliases("MYAPP")` produces `MYAPP_PORT ↔ ELIZA_PORT`,
 * `MYAPP_API_TOKEN ↔ ELIZA_API_TOKEN`, etc. The prefix is sourced from
 * `APP_CONFIG.envPrefix` (or `cliName` as fallback).
 */
import { buildBrandEnvAliases, normalizeBrandEnvPrefix } from "@elizaos/shared";
import { APP_CONFIG } from "./app-config";

export { buildBrandEnvAliases };

export const APP_ENV_PREFIX = normalizeBrandEnvPrefix(
  APP_CONFIG.envPrefix ?? APP_CONFIG.cliName,
);

/** Convenience export consumed by main.tsx boot config. */
export const APP_ENV_ALIASES = buildBrandEnvAliases(APP_ENV_PREFIX);
