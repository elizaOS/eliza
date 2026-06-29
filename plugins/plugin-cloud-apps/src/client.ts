/**
 * Eliza Cloud client construction + app resolution/formatting helpers.
 *
 * The agent reaches Eliza Cloud with the same credentials plugin-elizacloud
 * uses: the `ELIZAOS_CLOUD_API_KEY` setting (sent as the bearer/API key) and the
 * `ELIZAOS_CLOUD_BASE_URL` setting (the API base, e.g.
 * `https://www.elizacloud.ai/api/v1`). We mirror plugin-elizacloud's
 * `createElizaCloudClient` construction shape: the configured value is the API
 * base (it ends at `/api/v1`), so it is passed as `apiBaseUrl`; the site
 * `baseUrl` is the same origin with the `/api/v1` suffix stripped.
 */

import type { AppDto } from "@elizaos/cloud-sdk";
import { ElizaCloudClient } from "@elizaos/cloud-sdk";
import type { IAgentRuntime } from "@elizaos/core";

/** Default Eliza Cloud API base URL (matches the cloud runtime default). */
export const DEFAULT_CLOUD_API_BASE_URL = "https://www.elizacloud.ai/api/v1";

/** Settings key holding the Eliza Cloud API key. */
export const CLOUD_API_KEY_SETTING = "ELIZAOS_CLOUD_API_KEY";
/** Settings key holding the Eliza Cloud API base URL. */
export const CLOUD_BASE_URL_SETTING = "ELIZAOS_CLOUD_BASE_URL";

function normalizeSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Strip a trailing `/api/v1` so the SDK gets the bare site origin for `baseUrl`. */
function apiBaseToSiteBaseUrl(apiBaseUrl: string): string {
  const trimmed = trimTrailingSlash(apiBaseUrl);
  return trimmed.endsWith("/api/v1")
    ? trimmed.slice(0, -"/api/v1".length)
    : trimmed;
}

/** Resolve the Eliza Cloud API key from runtime settings. Returns null when unset. */
export function resolveCloudApiKey(runtime: IAgentRuntime): string | null {
  return normalizeSecret(runtime.getSetting(CLOUD_API_KEY_SETTING));
}

/** Resolve the Eliza Cloud API base URL (ends at `/api/v1`). */
export function resolveCloudApiBaseUrl(runtime: IAgentRuntime): string {
  return (
    normalizeSecret(runtime.getSetting(CLOUD_BASE_URL_SETTING)) ??
    DEFAULT_CLOUD_API_BASE_URL
  );
}

/**
 * Construct an authenticated {@link ElizaCloudClient} from runtime settings.
 * Returns `null` when no API key is configured so callers can degrade
 * gracefully (no key → no cloud calls).
 */
export function getCloudClient(
  runtime: IAgentRuntime,
): ElizaCloudClient | null {
  const apiKey = resolveCloudApiKey(runtime);
  if (!apiKey) return null;

  const apiBaseUrl = trimTrailingSlash(resolveCloudApiBaseUrl(runtime));
  return new ElizaCloudClient({
    apiBaseUrl,
    baseUrl: apiBaseToSiteBaseUrl(apiBaseUrl),
    apiKey,
  });
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/** Coerce a `numeric` decimal string (or number/null) into a finite number. */
function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A live, reachable URL for an app: prefer its production deploy, else its app URL. */
export function appUrl(app: AppDto): string | null {
  return normalizeSecret(app.production_url) ?? normalizeSecret(app.app_url);
}

/** Short human status combining deployment + active flags. */
export function appStatus(app: AppDto): string {
  const deployment = app.deployment_status ?? "draft";
  if (app.is_active === false) return `${deployment} (inactive)`;
  return deployment;
}

/** One-line summary for the list view: "Name — url — status". */
export function formatAppLine(app: AppDto): string {
  const parts = [app.name];
  const url = appUrl(app);
  if (url) parts.push(url);
  parts.push(appStatus(app));
  return `• ${parts.join(" — ")}`;
}

/** Multi-line detail block for a single app (GET_APP / provider). */
export function formatAppDetail(app: AppDto): string {
  const lines: string[] = [`${app.name} (${app.slug})`];
  if (normalizeSecret(app.description)) {
    lines.push(app.description as string);
  }
  const url = appUrl(app);
  if (url) lines.push(`URL: ${url}`);
  lines.push(`Status: ${appStatus(app)}`);

  const creditsUsed = toNumber(app.total_credits_used);
  if (creditsUsed !== null) {
    lines.push(`Credits used: $${creditsUsed.toFixed(2)}`);
  }
  if (app.monetization_enabled) {
    const earnings = toNumber(app.total_creator_earnings);
    lines.push(
      earnings !== null
        ? `Monetization: on — earnings $${earnings.toFixed(2)}`
        : "Monetization: on",
    );
  }
  if (typeof app.total_users === "number" && app.total_users > 0) {
    lines.push(`Users: ${app.total_users}`);
  }
  if (typeof app.total_requests === "number" && app.total_requests > 0) {
    lines.push(`Requests: ${app.total_requests}`);
  }
  return lines.join("\n");
}

/**
 * Resolve an app from a free-text reference (id or name) against a list.
 *
 * Match priority:
 *   1. exact id
 *   2. exact (case-insensitive) name or slug
 *   3. bidirectional substring on name/slug — the reference may be a fragment of
 *      the name ("acme") OR a full sentence containing the name ("tell me about
 *      my Acme Bot app"). The "reference contains name" direction requires a
 *      name/slug of >= 3 chars to avoid spurious matches inside a sentence.
 *
 * Returns null when nothing matches.
 */
export function findAppByReference(
  apps: AppDto[],
  reference: string,
): AppDto | null {
  const ref = reference.trim();
  if (!ref) return null;
  const lower = ref.toLowerCase();

  const byId = apps.find((a) => a.id === ref);
  if (byId) return byId;

  const byExactName = apps.find(
    (a) => a.name.toLowerCase() === lower || a.slug.toLowerCase() === lower,
  );
  if (byExactName) return byExactName;

  const matchesField = (field: string): boolean => {
    const f = field.toLowerCase();
    if (!f) return false;
    if (f.includes(lower)) return true; // reference is a fragment of the name
    return f.length >= 3 && lower.includes(f); // sentence contains the name
  };

  return apps.find((a) => matchesField(a.name) || matchesField(a.slug)) ?? null;
}

/** RFC-4122-ish UUID shape check (used to take the direct `getApp(id)` path). */
export function looksLikeAppId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}
