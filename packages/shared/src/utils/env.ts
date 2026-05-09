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

/**
 * Sync app brand env vars → elizaOS equivalents.
 */
export {
  syncBrandEnvToEliza,
  syncElizaEnvToBrand,
} from "../config/boot-config.js";

import {
  getBootConfig,
  syncBrandEnvToEliza,
  syncElizaEnvToBrand,
} from "../config/boot-config.js";

const DEFAULT_BRANDED_PREFIX = "ELIZA";
const DEFAULT_APP_ROUTE_PLUGIN_MODULES = [
  "@elizaos/app-vincent",
  "@elizaos/app-shopify",
  "@elizaos/app-steward",
  "@elizaos/app-lifeops",
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

function normalizeBrandedPrefix(prefix: string | undefined): string {
  const normalized = String(prefix ?? DEFAULT_BRANDED_PREFIX)
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

  if (!normalized) {
    throw new Error(
      "Branded env prefix must resolve to a non-empty identifier",
    );
  }

  return normalized;
}

function buildEnvPairs(
  brandedPrefix: string,
): Array<readonly [string, string]> {
  const prefixed = (suffix: string) => `${brandedPrefix}_${suffix}`;
  return [
    [prefixed("NAMESPACE"), "ELIZA_NAMESPACE"],
    [prefixed("STATE_DIR"), "ELIZA_STATE_DIR"],
    [prefixed("CONFIG_PATH"), "ELIZA_CONFIG_PATH"],
    [prefixed("OAUTH_DIR"), "ELIZA_OAUTH_DIR"],
    [prefixed("AGENT_ORCHESTRATOR"), "ELIZA_AGENT_ORCHESTRATOR"],
    [prefixed("CLOUD_PROVISIONED"), "ELIZA_CLOUD_PROVISIONED"],
    [
      prefixed("CHAT_GENERATION_TIMEOUT_MS"),
      "ELIZA_CHAT_GENERATION_TIMEOUT_MS",
    ],
    [prefixed("USE_PI_AI"), "ELIZA_USE_PI_AI"],
    [prefixed("SKIP_LOCAL_PLUGIN_ROLES"), "ELIZA_SKIP_LOCAL_PLUGIN_ROLES"],
    [prefixed("SETTINGS_DEBUG"), "ELIZA_SETTINGS_DEBUG"],
    [`VITE_${prefixed("SETTINGS_DEBUG")}`, "VITE_ELIZA_SETTINGS_DEBUG"],
    [
      prefixed("GOOGLE_OAUTH_DESKTOP_CLIENT_ID"),
      "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
    ],
    [prefixed("API_PORT"), "ELIZA_API_PORT"],
    [prefixed("API_BIND"), "ELIZA_API_BIND"],
    [prefixed("API_TOKEN"), "ELIZA_API_TOKEN"],
    [prefixed("ALLOWED_ORIGINS"), "ELIZA_ALLOWED_ORIGINS"],
    [prefixed("ALLOWED_HOSTS"), "ELIZA_ALLOWED_HOSTS"],
    [prefixed("ALLOW_NULL_ORIGIN"), "ELIZA_ALLOW_NULL_ORIGIN"],
    [prefixed("DISABLE_AUTO_API_TOKEN"), "ELIZA_DISABLE_AUTO_API_TOKEN"],
    [
      prefixed("TASK_AGENT_AUTH_TRUSTED_HOSTS"),
      "ELIZA_TASK_AGENT_AUTH_TRUSTED_HOSTS",
    ],
    [
      prefixed("TASK_AGENT_AUTH_API_BASE_URL"),
      "ELIZA_TASK_AGENT_AUTH_API_BASE_URL",
    ],
    [prefixed("APP_ROUTE_PLUGIN_MODULES"), "ELIZA_APP_ROUTE_PLUGIN_MODULES"],
    [prefixed("PORT"), "ELIZA_UI_PORT"],
  ];
}

export function syncAppEnvToEliza(): void {
  const aliases = getBootConfig().envAliases;
  if (aliases) syncBrandEnvToEliza(aliases);
}

export function syncElizaEnvAliases(options?: SyncElizaEnvAliasOptions): void {
  if (options) {
    const env = (
      globalThis as {
        process?: { env?: Record<string, string | undefined> };
      }
    ).process?.env;
    if (!env) return;

    const brandedPrefix = normalizeBrandedPrefix(options.brandedPrefix);
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
    return;
  }

  const aliases = getBootConfig().envAliases;
  if (aliases) syncElizaEnvToBrand(aliases);
}
