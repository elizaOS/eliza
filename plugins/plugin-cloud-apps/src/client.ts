/**
 * Eliza Cloud client construction + app resolution/formatting helpers.
 *
 * The agent reaches Eliza Cloud with the same credentials plugin-elizacloud
 * uses: the `ELIZAOS_CLOUD_API_KEY` setting (sent as the bearer/API key) and the
 * `ELIZAOS_CLOUD_BASE_URL` setting (the API base, e.g.
 * `https://elizacloud.ai/api/v1`). We mirror plugin-elizacloud's
 * `createElizaCloudClient` construction shape: the configured value is the API
 * base (it ends at `/api/v1`), so it is passed as `apiBaseUrl`; the site
 * `baseUrl` is the same origin with the `/api/v1` suffix stripped.
 */

import type { AppDto } from "@elizaos/cloud-sdk";
import { ElizaCloudClient } from "@elizaos/cloud-sdk";
import type { IAgentRuntime, Memory } from "@elizaos/core";

/** Default Eliza Cloud API base URL (matches the cloud runtime default). */
export const DEFAULT_CLOUD_API_BASE_URL = "https://elizacloud.ai/api/v1";

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
 * Resolve the Eliza Cloud dashboard (site) origin — the API base with a trailing
 * `/api/v1` stripped (e.g. `https://www.elizacloud.ai`). Used to build the
 * connector-agnostic CTA URLs the paid actions hand back so the user finishes a
 * money/credential step in the browser, never over the connector.
 */
export function resolveCloudSiteBaseUrl(runtime: IAgentRuntime): string {
  return apiBaseToSiteBaseUrl(resolveCloudApiBaseUrl(runtime));
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

/**
 * Draft/placeholder sentinel hosts the cloud uses for "not yet deployed" apps —
 * never surfaced to the user as a real URL.
 */
function isPlaceholderUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "placeholder.invalid" || host === "placeholder.local";
  } catch {
    return false;
  }
}

/** A live, reachable URL for an app: prefer its production deploy, else its app URL — never a draft sentinel. */
export function appUrl(app: AppDto): string | null {
  const prod = normalizeSecret(app.production_url);
  if (prod && !isPlaceholderUrl(prod)) return prod;
  const declared = normalizeSecret(app.app_url);
  if (declared && !isPlaceholderUrl(declared)) return declared;
  return null;
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
 * Result of resolving a free-text app reference: a single confident match, or —
 * when the reference is ambiguous (several apps match equally well) — no match
 * plus the tied `candidates`, so a destructive/money action can ask the user to
 * disambiguate instead of silently acting on the wrong app.
 */
export interface AppReferenceMatch {
  app: AppDto | null;
  candidates: AppDto[];
}

/** Escape a string for safe literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `needle` occurs in `haystack` bounded by non-alphanumeric
 * characters (a word boundary) — so "bot" matches "delete bot" but NOT the
 * "bot" inside "chatbot". Both sides are matched case-insensitively.
 */
function containsAsWholeWord(haystack: string, needle: string): boolean {
  return new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`,
    "i",
  ).test(haystack);
}

/**
 * Specificity score for how well the lowercased reference `lower` targets one
 * of an item's `names`. 0 = no match; higher = more specific:
 *   - the name appears in the reference as WHOLE WORDS (a sentence naming the
 *     item) — scored by the matched name length, so a longer, more specific
 *     name ("Prod API Backup", 15) beats a prefix ("Prod API", 8).
 *   - otherwise the reference is a substring the user typed of the name (a
 *     fragment like "acme") — always scored below any whole-word match.
 */
function referenceScore(lower: string, names: string[]): number {
  let best = 0;
  for (const field of names) {
    const f = field.toLowerCase();
    if (!f) continue;
    if (f.length >= 3 && containsAsWholeWord(lower, f)) {
      best = Math.max(best, 1000 + f.length);
    } else if (lower.length >= 2 && f.includes(lower)) {
      best = Math.max(best, 500 + lower.length);
    }
  }
  return best;
}

/**
 * Result of {@link matchByReference}: a single confident match, or — when the
 * reference is ambiguous (several items match equally well) — no match plus
 * the tied `candidates`, so a destructive/money action can ask the user to
 * disambiguate instead of silently acting on the wrong target.
 */
export interface ReferenceMatch<T> {
  item: T | null;
  candidates: T[];
}

/**
 * Resolve an item (app, influencer profile, …) from a free-text reference
 * against a list, ambiguity-aware. `identify` maps each item to its stable id
 * plus the human names it answers to (name, slug, display name, …).
 *
 * Match priority:
 *   1. exact id
 *   2. exact (case-insensitive) name
 *   3. best-scoring fuzzy match ({@link referenceScore}) — a whole-word
 *      name-in-sentence beats a typed fragment, and a longer name beats a
 *      shorter prefix. When two or more items tie for the top score the result
 *      is AMBIGUOUS: `item` is null and `candidates` holds the tied items.
 *
 * Never silently returns the first of several equally-good matches: destructive
 * references such as "delete Prod API Backup" must not resolve to the shorter
 * "Prod API" prefix, "delete my chatbot helper" must not match an app named
 * "Bot", and adversarial influencer names must not capture someone else's
 * booking.
 */
export function matchByReference<T>(
  items: T[],
  reference: string,
  identify: (item: T) => {
    id: string;
    names: Array<string | null | undefined>;
  },
): ReferenceMatch<T> {
  const ref = reference.trim();
  if (!ref) return { item: null, candidates: [] };
  const lower = ref.toLowerCase();

  const namesOf = (item: T): string[] =>
    identify(item).names.filter(
      (n): n is string => typeof n === "string" && n.length > 0,
    );

  const byId = items.find((item) => identify(item).id === ref);
  if (byId) return { item: byId, candidates: [byId] };

  const exact = items.filter((item) =>
    namesOf(item).some((n) => n.toLowerCase() === lower),
  );
  if (exact.length === 1) return { item: exact[0], candidates: exact };
  if (exact.length > 1) return { item: null, candidates: exact };

  const scored = items
    .map((item) => ({ item, score: referenceScore(lower, namesOf(item)) }))
    .filter((s) => s.score > 0);
  if (scored.length === 0) return { item: null, candidates: [] };

  const max = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === max).map((s) => s.item);
  return top.length === 1
    ? { item: top[0], candidates: top }
    : { item: null, candidates: top };
}

/**
 * Resolve an app from a free-text reference against a list, ambiguity-aware.
 * App-typed wrapper over {@link matchByReference} (id → exact name/slug →
 * whole-word-in-sentence → fragment; ties = ambiguous).
 */
export function matchAppByReference(
  apps: AppDto[],
  reference: string,
): AppReferenceMatch {
  const match = matchByReference(apps, reference, (a) => ({
    id: a.id,
    names: [a.name, a.slug],
  }));
  return { app: match.item, candidates: match.candidates };
}

/**
 * Back-compat single-result resolver: the confident match, or null (including
 * when the reference is ambiguous). Prefer {@link matchAppByReference} when you
 * need to surface the tied candidates to the user.
 */
export function findAppByReference(
  apps: AppDto[],
  reference: string,
): AppDto | null {
  return matchAppByReference(apps, reference).app;
}

/** RFC-4122-ish UUID shape check (used to take the direct `getApp(id)` path). */
export function looksLikeAppId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

// ─── Reference resolution (shared by the mutating actions) ───────────────────

/** Planner-option keys that may carry an app reference, in priority order. */
const REFERENCE_OPTION_KEYS = [
  "app",
  "appName",
  "name",
  "id",
  "appId",
  "query",
] as const;

/**
 * The candidate objects that may carry planner-validated action args, most
 * authoritative first. On the real planner path the validated args arrive
 * NESTED under `options.parameters` (execute-planned-tool-call.ts sets
 * `handlerOptions.parameters = validation.args`); only direct handler calls /
 * scenario `action`-kind turns place them at the top level. Mirrors
 * `readStructuredConfirmation` (safety.ts) and `actionParams`
 * (domain-intent.ts) so every option read sees both shapes, nested first.
 */
export function plannerOptionSources(
  options?: unknown,
): ReadonlyArray<Record<string, unknown>> {
  if (!options || typeof options !== "object") return [];
  const top = options as Record<string, unknown>;
  const nested =
    top.parameters && typeof top.parameters === "object"
      ? (top.parameters as Record<string, unknown>)
      : undefined;
  return nested ? [nested, top] : [top];
}

/**
 * Pull an app reference from planner-supplied options (nested
 * `options.parameters` first — the real planner path — then top-level) or,
 * failing that, the raw message text. Mirrors the read-core's
 * `resolveReference` so the mutating actions resolve apps identically.
 */
export function extractAppReference(
  message: Memory,
  options?: unknown,
): string {
  for (const source of plannerOptionSources(options)) {
    for (const key of REFERENCE_OPTION_KEYS) {
      const value = source[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  return (message.content?.text ?? "").trim();
}

export interface ResolvedApp {
  /** The matched app, or null when nothing matched OR the reference was ambiguous. */
  app: AppDto | null;
  /** Names of the user's apps (for a helpful not-found message). */
  available: string[];
  /**
   * Names of the tied candidate apps when the reference was AMBIGUOUS (set only
   * when `app` is null because >1 app matched equally well). Lets a
   * destructive/money action ask "which one?" instead of a generic not-found.
   */
  ambiguous?: string[];
}

/**
 * Resolve an app from a free-text reference against the user's apps. Id-shaped
 * references take the direct `getApp(id)` path; names resolve via `listApps()` +
 * {@link matchAppByReference}. Read-only — used by the mutating actions to locate
 * the target before they mutate it. When the reference is ambiguous, `app` is
 * null and `ambiguous` holds the tied candidate names.
 */
export async function resolveApp(
  client: ElizaCloudClient,
  reference: string,
): Promise<ResolvedApp> {
  if (looksLikeAppId(reference)) {
    const { app } = await client.getApp(reference);
    if (app) return { app, available: [app.name] };
  }
  const { apps } = await client.listApps();
  const list = apps ?? [];
  const match = matchAppByReference(list, reference);
  return {
    app: match.app,
    available: list.map((a) => a.name),
    ambiguous:
      match.app === null && match.candidates.length > 1
        ? match.candidates.map((a) => a.name)
        : undefined,
  };
}
