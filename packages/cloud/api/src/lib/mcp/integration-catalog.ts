/**
 * Trust, availability, and kill-switch policy for the first-party MCP
 * integration catalog. The public catalog routes (`mcp/registry`, `mcp/list`)
 * and the `/api/mcps/:provider/:transport` gateway consult this module so the
 * platform never advertises an endpoint that would answer 501/unconfigured,
 * honors the operator kill switch consistently, and only exposes
 * risk-reviewed write capabilities to planners.
 *
 * Availability is derived from the same environment contract the transport
 * gateway executes (`MCP_<PROVIDER>_STREAMABLE_HTTP_URL` for operator-proxied
 * providers, built-in Workers transports for time/weather/crypto). The kill
 * switch is the `MCP_KILL_SWITCH` env var: a comma-separated list of catalog
 * ids and/or provider slugs, or `all`.
 */

export type IntegrationAvailability = "available" | "disabled" | "unconfigured";
export type IntegrationProvenance =
  | "first-party"
  | "operator-proxied"
  | "community";
export type IntegrationAuthMode = "none" | "session" | "api-key" | "oauth";
export type IntegrationHealth = "operational" | "unknown" | "unavailable";

export interface IntegrationCapability {
  readonly name: string;
  readonly access: "read" | "write";
  /** True once the capability passed a risk review; unreviewed writes are hidden from planners. */
  readonly reviewed: boolean;
}

export interface IntegrationTrust {
  readonly publisher: string;
  readonly provenance: IntegrationProvenance;
  readonly authMode: IntegrationAuthMode;
  /** Upstream network domains the integration contacts (empty for on-platform tools). */
  readonly domains: readonly string[];
  /** ISO date of the most recent capability risk review. */
  readonly reviewedAt: string;
  readonly capabilities: readonly IntegrationCapability[];
}

/** Minimal env shape the policy reads; matches `Bindings`' string index. */
export interface IntegrationPolicyEnv {
  readonly [key: string]: unknown;
}

/** Provider slugs served natively by the Workers transport gateway. */
const BUILTIN_PROVIDERS = new Set<string>(["time", "weather", "crypto"]);

/** Catalog ids served by `/api/mcp` itself (always deployable with the Worker). */
const PLATFORM_IDS = new Set<string>(["eliza-platform", "eliza-cloud-mcp"]);

const read = (name: string): IntegrationCapability => ({
  name,
  access: "read",
  reviewed: true,
});
const write = (name: string): IntegrationCapability => ({
  name,
  access: "write",
  reviewed: true,
});

/**
 * Trust metadata for every first-party catalog entry, keyed by catalog id.
 * `mcp/list` and `mcp/registry` use different ids for the same integration;
 * both aliases are present so either surface resolves the same record.
 */
export const INTEGRATION_TRUST: Readonly<Record<string, IntegrationTrust>> =
  (() => {
    const platform: IntegrationTrust = {
      publisher: "elizaOS",
      provenance: "first-party",
      authMode: "api-key",
      domains: [],
      reviewedAt: "2026-08-20",
      capabilities: [
        read("check_credits"),
        read("get_recent_usage"),
        read("get_usage"),
        read("search_web"),
        read("extract_page"),
        write("browser_session"),
        write("generate_text"),
        write("generate_image"),
        write("save_memory"),
        read("retrieve_memories"),
        write("chat_with_agent"),
        read("list_agents"),
        read("list_containers"),
        read("conversation_management"),
      ],
    };
    const time: IntegrationTrust = {
      publisher: "elizaOS",
      provenance: "first-party",
      authMode: "none",
      domains: [],
      reviewedAt: "2026-08-20",
      capabilities: [
        read("get_current_time"),
        read("convert_timezone"),
        read("format_date"),
        read("calculate_time_diff"),
        read("list_timezones"),
      ],
    };
    const weather: IntegrationTrust = {
      publisher: "elizaOS",
      provenance: "first-party",
      authMode: "none",
      domains: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
      reviewedAt: "2026-08-20",
      capabilities: [
        read("get_current_weather"),
        read("get_weather_forecast"),
        read("compare_weather"),
        read("search_location"),
      ],
    };
    const crypto: IntegrationTrust = {
      publisher: "elizaOS",
      provenance: "first-party",
      authMode: "none",
      domains: ["api.coingecko.com"],
      reviewedAt: "2026-08-20",
      capabilities: [
        read("get_price"),
        read("get_market_data"),
        read("list_trending"),
      ],
    };
    return {
      "eliza-platform": platform,
      "eliza-cloud-mcp": platform,
      "time-server": time,
      "time-mcp": time,
      weather,
      "weather-mcp": weather,
      "crypto-prices": crypto,
      "crypto-mcp": crypto,
      "web-search": {
        publisher: "elizaOS",
        provenance: "operator-proxied",
        authMode: "api-key",
        domains: [],
        reviewedAt: "2026-08-20",
        capabilities: [read("search"), read("fetch_page")],
      },
      linear: {
        publisher: "Linear (proxied by elizaOS)",
        provenance: "operator-proxied",
        authMode: "oauth",
        domains: ["api.linear.app"],
        reviewedAt: "2026-08-20",
        capabilities: [
          read("linear_list_issues"),
          write("linear_create_issue"),
          read("linear_list_projects"),
          read("linear_list_teams"),
        ],
      },
      notion: {
        publisher: "Notion (proxied by elizaOS)",
        provenance: "operator-proxied",
        authMode: "oauth",
        domains: ["api.notion.com"],
        reviewedAt: "2026-08-20",
        capabilities: [
          read("notion_search"),
          write("notion_create_page"),
          read("notion_get_database"),
          read("notion_query_data_source"),
        ],
      },
      github: {
        publisher: "GitHub (proxied by elizaOS)",
        provenance: "operator-proxied",
        authMode: "oauth",
        domains: ["api.github.com"],
        reviewedAt: "2026-08-20",
        capabilities: [
          read("github_list_repos"),
          write("github_create_issue"),
          read("github_list_prs"),
          write("github_create_pr"),
        ],
      },
    };
  })();

/** Env var the transport gateway resolves for an operator-proxied provider. */
export function upstreamEnvKeyForProvider(provider: string): string {
  const slug = provider.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return `MCP_${slug}_STREAMABLE_HTTP_URL`;
}

/** Extracts the `/api/mcps/<provider>/...` slug from a catalog endpoint, if any. */
export function providerSlugFromEndpoint(endpoint: string): string | null {
  const match = /\/api\/mcps\/([a-z0-9-]+)(?:\/|$)/i.exec(endpoint);
  return match ? match[1].toLowerCase() : null;
}

export interface KillSwitchState {
  readonly all: boolean;
  readonly ids: ReadonlySet<string>;
}

/**
 * Parses `MCP_KILL_SWITCH`. Non-string or empty input yields an inert switch;
 * tokens are trimmed and lowercased so operator formatting cannot silently
 * disarm the switch.
 */
export function parseKillSwitch(raw: unknown): KillSwitchState {
  // error-policy:J3 untrusted operator env — malformed input becomes an
  // explicit inert switch, never a partially-armed guess.
  if (typeof raw !== "string") return { all: false, ids: new Set() };
  const tokens = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.includes("all") || tokens.includes("*")) {
    return { all: true, ids: new Set(tokens) };
  }
  return { all: false, ids: new Set(tokens) };
}

/**
 * Catalog-id aliases per gateway provider slug, so a kill-switch token written
 * as either the slug (`crypto`) or a catalog id (`crypto-prices`, `crypto-mcp`)
 * disables both the catalog listing and the transport route.
 */
const PROVIDER_SLUG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  time: ["time-server", "time-mcp"],
  weather: ["weather-mcp"],
  crypto: ["crypto-prices", "crypto-mcp"],
  search: ["web-search"],
};

/** True when the kill switch disables the given catalog id / provider slug. */
export function isKillSwitched(
  env: IntegrationPolicyEnv,
  catalogId: string,
  providerSlug: string | null,
): boolean {
  const state = parseKillSwitch(env.MCP_KILL_SWITCH);
  if (state.all) return true;
  if (state.ids.has(catalogId.toLowerCase())) return true;
  if (providerSlug === null) return false;
  if (state.ids.has(providerSlug)) return true;
  const aliases = PROVIDER_SLUG_ALIASES[providerSlug] ?? [];
  return aliases.some((alias) => state.ids.has(alias));
}

/**
 * Resolves whether the catalog may advertise an integration. `unconfigured`
 * entries must not be listed at all — their transport route answers 501.
 */
export function resolveIntegrationAvailability(
  env: IntegrationPolicyEnv,
  catalogId: string,
  endpoint: string,
): IntegrationAvailability {
  const providerSlug = providerSlugFromEndpoint(endpoint);
  if (isKillSwitched(env, catalogId, providerSlug)) return "disabled";
  if (PLATFORM_IDS.has(catalogId)) return "available";
  if (providerSlug === null) return "unconfigured";
  if (BUILTIN_PROVIDERS.has(providerSlug)) return "available";
  const upstream = env[upstreamEnvKeyForProvider(providerSlug)];
  return typeof upstream === "string" && upstream.trim().length > 0
    ? "available"
    : "unconfigured";
}

/** Health state the catalog reports; only live probing could upgrade "unknown". */
export function integrationHealth(
  availability: IntegrationAvailability,
  provenance: IntegrationProvenance,
): IntegrationHealth {
  if (availability !== "available") return "unavailable";
  return provenance === "first-party" ? "operational" : "unknown";
}

/**
 * Capabilities a planner may see: every reviewed capability plus unreviewed
 * reads. Unreviewed writes are withheld until a risk review lands.
 */
export function plannerVisibleCapabilities(
  capabilities: readonly IntegrationCapability[],
): IntegrationCapability[] {
  return capabilities.filter(
    (capability) => capability.reviewed || capability.access === "read",
  );
}

/**
 * Filters an advertised feature/tool-name list down to planner-visible
 * capability names. Names without a trust record are dropped — an unreviewed
 * capability must never reach the planner by omission.
 */
export function plannerVisibleFeatures(
  trust: IntegrationTrust,
  features: readonly string[],
): string[] {
  const visible = new Set(
    plannerVisibleCapabilities(trust.capabilities).map((c) => c.name),
  );
  return features.filter((feature) => visible.has(feature));
}
