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

function normalizeBrandedPrefix(prefix) {
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

function buildEnvPairs(brandedPrefix) {
  const prefixed = (suffix) => `${brandedPrefix}_${suffix}`;
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

/**
 * Mirror branded app env vars into ELIZA_* so shared elizaOS packages only
 * need to resolve one canonical namespace internally.
 */
export function syncElizaEnvAliases(options = {}) {
  const brandedPrefix = normalizeBrandedPrefix(options.brandedPrefix);
  const pairs = buildEnvPairs(brandedPrefix);
  for (const [from, to] of pairs) {
    if (process.env[to] === undefined && process.env[from] !== undefined) {
      process.env[to] = process.env[from];
    }
  }
  if (!process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT) {
    process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT =
      options.cloudManagedAgentsApiSegment ?? "eliza";
  }
  if (!process.env.ELIZA_APP_ROUTE_PLUGIN_MODULES) {
    process.env.ELIZA_APP_ROUTE_PLUGIN_MODULES = (
      options.appRoutePluginModules ?? DEFAULT_APP_ROUTE_PLUGIN_MODULES
    ).join(",");
  }
}
