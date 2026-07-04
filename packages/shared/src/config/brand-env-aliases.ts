export type BrandEnvAliasPair = readonly [brandKey: string, elizaKey: string];

interface BrandEnvAliasDefinition {
  readonly brandSuffix: string;
  readonly elizaKey: string;
  readonly syncElizaKey?: string;
  readonly vite?: boolean;
}

export const BRAND_ENV_ALIAS_DEFINITIONS = [
  // Identity, state, and app boot
  { brandSuffix: "NAMESPACE", elizaKey: "ELIZA_NAMESPACE" },
  { brandSuffix: "STATE_DIR", elizaKey: "ELIZA_STATE_DIR" },
  { brandSuffix: "CONFIG_PATH", elizaKey: "ELIZA_CONFIG_PATH" },
  { brandSuffix: "OAUTH_DIR", elizaKey: "ELIZA_OAUTH_DIR" },
  { brandSuffix: "PLATFORM", elizaKey: "ELIZA_PLATFORM" },
  { brandSuffix: "AGENT_ORCHESTRATOR", elizaKey: "ELIZA_AGENT_ORCHESTRATOR" },
  { brandSuffix: "CLOUD_PROVISIONED", elizaKey: "ELIZA_CLOUD_PROVISIONED" },
  {
    brandSuffix: "CLOUD_MANAGED_AGENTS_API_SEGMENT",
    elizaKey: "ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT",
  },
  {
    brandSuffix: "CHAT_GENERATION_TIMEOUT_MS",
    elizaKey: "ELIZA_CHAT_GENERATION_TIMEOUT_MS",
  },
  {
    brandSuffix: "SKIP_LOCAL_PLUGIN_ROLES",
    elizaKey: "ELIZA_SKIP_LOCAL_PLUGIN_ROLES",
  },
  { brandSuffix: "SETTINGS_DEBUG", elizaKey: "ELIZA_SETTINGS_DEBUG" },
  {
    brandSuffix: "SETTINGS_DEBUG",
    elizaKey: "VITE_ELIZA_SETTINGS_DEBUG",
    vite: true,
  },
  {
    brandSuffix: "GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
    elizaKey: "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
  },
  {
    brandSuffix: "APP_ROUTE_PLUGIN_MODULES",
    elizaKey: "ELIZA_APP_ROUTE_PLUGIN_MODULES",
  },
  // API and auth
  { brandSuffix: "API_TOKEN", elizaKey: "ELIZA_API_TOKEN" },
  { brandSuffix: "API_BIND", elizaKey: "ELIZA_API_BIND" },
  { brandSuffix: "API_EXPOSE_PORT", elizaKey: "ELIZA_API_EXPOSE_PORT" },
  { brandSuffix: "PAIRING_DISABLED", elizaKey: "ELIZA_PAIRING_DISABLED" },
  { brandSuffix: "ALLOWED_ORIGINS", elizaKey: "ELIZA_ALLOWED_ORIGINS" },
  { brandSuffix: "ALLOWED_HOSTS", elizaKey: "ELIZA_ALLOWED_HOSTS" },
  { brandSuffix: "ALLOW_NULL_ORIGIN", elizaKey: "ELIZA_ALLOW_NULL_ORIGIN" },
  {
    brandSuffix: "ALLOW_WS_QUERY_TOKEN",
    elizaKey: "ELIZA_ALLOW_WS_QUERY_TOKEN",
  },
  {
    brandSuffix: "DISABLE_AUTO_API_TOKEN",
    elizaKey: "ELIZA_DISABLE_AUTO_API_TOKEN",
  },
  {
    brandSuffix: "WALLET_EXPORT_TOKEN",
    elizaKey: "ELIZA_WALLET_EXPORT_TOKEN",
  },
  {
    brandSuffix: "TERMINAL_RUN_TOKEN",
    elizaKey: "ELIZA_TERMINAL_RUN_TOKEN",
  },
  // API base and desktop shell routing
  { brandSuffix: "API_BASE", elizaKey: "ELIZA_API_BASE" },
  { brandSuffix: "API_BASE_URL", elizaKey: "ELIZA_API_BASE_URL" },
  { brandSuffix: "DESKTOP_API_BASE", elizaKey: "ELIZA_DESKTOP_API_BASE" },
  {
    brandSuffix: "DESKTOP_TEST_API_BASE",
    elizaKey: "ELIZA_DESKTOP_TEST_API_BASE",
  },
  {
    brandSuffix: "DESKTOP_SKIP_EMBEDDED_AGENT",
    elizaKey: "ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT",
  },
  { brandSuffix: "RENDERER_URL", elizaKey: "ELIZA_RENDERER_URL" },
  // Cloud service toggles
  { brandSuffix: "CLOUD_TTS_DISABLED", elizaKey: "ELIZA_CLOUD_TTS_DISABLED" },
  {
    brandSuffix: "CLOUD_MEDIA_DISABLED",
    elizaKey: "ELIZA_CLOUD_MEDIA_DISABLED",
  },
  {
    brandSuffix: "CLOUD_EMBEDDINGS_DISABLED",
    elizaKey: "ELIZA_CLOUD_EMBEDDINGS_DISABLED",
  },
  { brandSuffix: "CLOUD_RPC_DISABLED", elizaKey: "ELIZA_CLOUD_RPC_DISABLED" },
  {
    brandSuffix: "DISABLE_LOCAL_EMBEDDINGS",
    elizaKey: "ELIZA_DISABLE_LOCAL_EMBEDDINGS",
  },
  { brandSuffix: "DISABLE_EDGE_TTS", elizaKey: "ELIZA_DISABLE_EDGE_TTS" },
  // Ports
  {
    brandSuffix: "PORT",
    elizaKey: "ELIZA_PORT",
    syncElizaKey: "ELIZA_UI_PORT",
  },
  { brandSuffix: "UI_PORT", elizaKey: "ELIZA_UI_PORT" },
  { brandSuffix: "API_PORT", elizaKey: "ELIZA_API_PORT" },
  { brandSuffix: "HOME_PORT", elizaKey: "ELIZA_HOME_PORT" },
  { brandSuffix: "GATEWAY_PORT", elizaKey: "ELIZA_GATEWAY_PORT" },
  { brandSuffix: "BRIDGE_PORT", elizaKey: "ELIZA_BRIDGE_PORT" },
] as const satisfies readonly BrandEnvAliasDefinition[];

export function normalizeBrandEnvPrefix(prefix: string | undefined): string {
  const normalized = String(prefix ?? "ELIZA")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

  if (!normalized) {
    throw new Error("Brand env prefix must resolve to a non-empty identifier");
  }

  return normalized;
}

export function buildBrandEnvAliases(prefix: string): BrandEnvAliasPair[] {
  const normalizedPrefix = normalizeBrandEnvPrefix(prefix);
  return BRAND_ENV_ALIAS_DEFINITIONS.map((definition) => {
    const brandKey =
      "vite" in definition && definition.vite
        ? `VITE_${normalizedPrefix}_${definition.brandSuffix}`
        : `${normalizedPrefix}_${definition.brandSuffix}`;
    return [brandKey, definition.elizaKey] as const;
  });
}

export function buildBrandEnvSyncAliases(prefix: string): BrandEnvAliasPair[] {
  const normalizedPrefix = normalizeBrandEnvPrefix(prefix);
  return BRAND_ENV_ALIAS_DEFINITIONS.map((definition) => {
    const brandKey =
      "vite" in definition && definition.vite
        ? `VITE_${normalizedPrefix}_${definition.brandSuffix}`
        : `${normalizedPrefix}_${definition.brandSuffix}`;
    return [brandKey, definition.syncElizaKey ?? definition.elizaKey] as const;
  });
}
