/**
 * Eliza Cloud — single source of truth for default origins, API bases, and
 * dashboard URLs shared by `@elizaos/agent` and `@elizaos/app-core`.
 *
 * Product copy still lives in i18n; pass `ELIZA_CLOUD_PUBLIC_HOST` (or full
 * URLs from this module) into `t()` where strings need a hostname.
 *
 * **`ELIZA_CLOUD_PUBLIC_HOST`** is mixed-case branding (`ElizaCloud.ai`).
 * **`…_ORIGIN` / API URLs** stay lowercase hostnames — valid HTTPS and
 * cookie/domain matching; browsers treat hostnames as case-insensitive.
 */

/** Primary web origin (dashboards, default cloud “site” URL). */
export const ELIZA_CLOUD_PRIMARY_ORIGIN = "https://www.elizacloud.ai";

/** Apex origin for marketing / legacy “learn more” links. */
export const ELIZA_CLOUD_MARKETING_ORIGIN = "https://elizacloud.ai";

/** Hostname without scheme — UI labels, i18n `{{cloudPublicHost}}`, search keywords. */
export const ELIZA_CLOUD_PUBLIC_HOST = "ElizaCloud.ai";

/**
 * Default “cloud site” URL (no `/api/v1`) — boot config `cloudApiBase`,
 * `normalizeCloudSiteUrl` fallback, and similar.
 */
export const ELIZA_CLOUD_DEFAULT_SITE_URL = ELIZA_CLOUD_PRIMARY_ORIGIN;

/** Default REST API base including `/api/v1`. */
export const ELIZA_CLOUD_API_V1_DEFAULT = `${ELIZA_CLOUD_PRIMARY_ORIGIN}/api/v1`;

/**
 * Some runtimes still default to the API subdomain; keep as explicit fallback
 * only where that legacy default is required.
 */
export const ELIZA_CLOUD_LEGACY_API_ORIGIN = "https://api.elizacloud.ai";

/**
 * Hostnames accepted from legacy configs (always lowercase — compared after
 * `hostname.toLowerCase()` in `normalizeCloudSiteUrl`).
 */
export const ELIZA_CLOUD_LEGACY_HOSTNAMES = new Set<string>([
  "elizacloud.ai",
  "www.elizacloud.ai",
]);

/** Built-in dashboard / marketing URLs (no env overrides). */
export const ELIZA_CLOUD_URLS = {
  /** Main web dashboard after sign-in (in-app “Advanced external dashboard” link). */
  dashboardApp: `${ELIZA_CLOUD_PRIMARY_ORIGIN}/dashboard`,
  dashboardApiKeys: `${ELIZA_CLOUD_PRIMARY_ORIGIN}/dashboard/api-keys`,
  dashboardSettings: `${ELIZA_CLOUD_PRIMARY_ORIGIN}/dashboard/settings`,
  billingSettings: `${ELIZA_CLOUD_PRIMARY_ORIGIN}/dashboard/settings?tab=billing`,
  marketingSite: ELIZA_CLOUD_MARKETING_ORIGIN,
  marketingDashboardSettings: `${ELIZA_CLOUD_MARKETING_ORIGIN}/dashboard/settings`,
} as const;
