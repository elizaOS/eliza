/**
 * Environment variable normalization helpers.
 *
 * Consolidates the `normalizeSecret` / `normalizeEnvValue` pattern that was
 * independently implemented in cloud connection, steward bridge, and wallet
 * trade helpers.
 */

/**
 * Normalize an env value: trim whitespace, return `undefined` for empty/missing.
 * Accepts `unknown` so callers don't need to narrow first (useful for config objects).
 */
export function normalizeEnvValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Same as `normalizeEnvValue` but returns `null` instead of `undefined`.
 * Convenient when building option objects where `null` means "absent".
 */
export function normalizeEnvValueOrNull(value: unknown): string | null {
  return normalizeEnvValue(value) ?? null;
}

/**
 * Returns `true` if a boolean-ish env var is falsy (`"0"`, `"false"`, `"off"`, `"no"`).
 * Missing or empty values return `false` (i.e. the feature is enabled by default).
 */
export function isEnvDisabled(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "0" || raw === "false" || raw === "off" || raw === "no";
}

import { resolveAliasedEnvValue } from "../config/boot-config.js";
import {
  buildBrandEnvSyncAliases,
  normalizeBrandEnvPrefix,
} from "../config/brand-env-aliases.js";

const DEFAULT_BRANDED_PREFIX = "ELIZA";
export const DEFAULT_APP_ROUTE_PLUGIN_MODULES = [
  "@elizaos/plugin-shopify",
  "@elizaos/plugin-personal-assistant",
  "@elizaos/plugin-github",
  "@elizaos/plugin-computeruse",
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-workflow",
];

export interface SyncElizaEnvAliasOptions {
  brandedPrefix?: string;
  cloudManagedAgentsApiSegment?: string;
  appRoutePluginModules?: readonly string[];
}

function buildEnvPairs(
  brandedPrefix: string,
): Array<readonly [string, string]> {
  return buildBrandEnvSyncAliases(brandedPrefix);
}

/**
 * Read an env value resolving brand<->eliza aliases from the immutable
 * BootConfig, WITHOUT mutating `process.env` (arch-audit #12251).
 *
 * Thin wrapper over core's {@link resolveAliasedEnvValue} that pins the alias
 * table to `getBootConfig().envAliases` and normalizes the result via
 * {@link normalizeEnvValue} (trim + empty -> undefined), so read sites get the
 * same trimmed-or-undefined contract as a normalized `process.env.<key>` read.
 * This is the sole brand<->eliza env-resolution path — the old sync mutation
 * was removed in #13423.
 */
export function readAliasedEnv(key: string): string | undefined {
  return normalizeEnvValue(resolveAliasedEnvValue(key));
}

/**
 * Build/launch-time env normalization for a white-label app bundle, run from
 * `apps/app/vite.config.ts` BEFORE any BootConfig alias table exists (config
 * eval and the dev orchestrator seed ports off `process.env`, and the port
 * resolvers in `runtime-env.ts` only alias-resolve once a BootConfig is set).
 *
 * It copies a brand `<PREFIX>_*` value into its `ELIZA_*` partner only when the
 * partner is unset, then seeds two `ELIZA_*` defaults. Unlike the deleted
 * runtime alias-sync mutation (#13423), this runs exactly once at build/launch
 * on the host process — the agent runtime resolves brand aliases through the
 * BootConfig reader ({@link readAliasedEnv}) and never mutates `process.env`.
 */
export function syncElizaEnvAliases(
  options: SyncElizaEnvAliasOptions = {},
): void {
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  if (!env) return;

  const brandedPrefix = normalizeBrandEnvPrefix(
    options.brandedPrefix ?? DEFAULT_BRANDED_PREFIX,
  );
  for (const [from, to] of buildEnvPairs(brandedPrefix)) {
    if (env[to] === undefined && env[from] !== undefined) {
      env[to] = env[from];
    }
  }
  if (!env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT) {
    env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT =
      options.cloudManagedAgentsApiSegment ?? "eliza";
  }
  if (!env.ELIZA_APP_ROUTE_PLUGIN_MODULES) {
    env.ELIZA_APP_ROUTE_PLUGIN_MODULES = (
      options.appRoutePluginModules ?? DEFAULT_APP_ROUTE_PLUGIN_MODULES
    ).join(",");
  }
}
