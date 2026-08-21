/**
 * Cloud-routed ElevenLabs voice catalog.
 *
 * The Eliza Cloud SDK exposes two voice-listing endpoints:
 *   - `GET /api/elevenlabs/voices` — ElevenLabs **premade** voices (shared).
 *   - `GET /api/elevenlabs/voices/user` — voices cloned / saved by the
 *     authenticated user.
 *
 * We expose the union of both to consumers so the dashboard, the agent, and
 * any other client see the full set of voices the user can actually use.
 *
 * Results are cached in-memory for {@link CACHE_TTL_MS} (1 hour). The cache
 * is keyed by the runtime's cloud base URL + API key so multi-tenant or
 * test-isolated runtimes don't share entries. Endpoint failures degrade
 * independently, but a total upstream outage is never cached as a genuine
 * empty catalog — instead it's remembered as a short-lived failure
 * ({@link FAILURE_TTL_MS}) so a sustained outage doesn't turn every caller's
 * request into an upstream round trip, while still recovering quickly once
 * the outage clears. Concurrent callers during a miss or outage share one
 * in-flight fetch (`inflight`) rather than each firing their own pair of
 * requests.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getApiKey, getBaseURL, isCloudTtsAvailable } from "./utils/config";
import { createElizaCloudClient } from "./utils/sdk-client";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
// Short enough that a real recovery is picked up quickly, long enough that a
// burst of callers during an outage doesn't each re-hit both endpoints.
const FAILURE_TTL_MS = 30 * 1000;

export interface CloudVoiceCatalogEntry {
  id: string;
  name: string;
  gender?: string;
  preview?: string;
  category?: string;
  language?: string;
}

/**
 * Narrow interface the catalog actually uses. Lets tests substitute a
 * fake without rebuilding the full SDK surface.
 */
export interface CloudVoiceClient {
  routes: {
    getApiElevenlabsVoices<T = unknown>(options?: {
      query?: Record<string, unknown>;
    }): Promise<T>;
    getApiElevenlabsVoicesUser<T = unknown>(options?: {
      query?: Record<string, unknown>;
    }): Promise<T>;
  };
}

type ClientFactory = (runtime: IAgentRuntime) => CloudVoiceClient;

let clientFactory: ClientFactory = (runtime) =>
  createElizaCloudClient(runtime) as CloudVoiceClient;

/**
 * Test seam: substitute the SDK client factory. Pass `null` to reset to
 * the real `createElizaCloudClient`. Production code should never call
 * this.
 */
export function setCloudVoiceClientFactoryForTesting(
  factory: ClientFactory | null,
): void {
  if (factory === null) {
    clientFactory = (runtime) =>
      createElizaCloudClient(runtime) as CloudVoiceClient;
  } else {
    clientFactory = factory;
  }
}

type EndpointCacheEntry =
  | { kind: "success"; fetchedAt: number; voices: CloudVoiceCatalogEntry[] }
  | { kind: "failure"; fetchedAt: number };

type EndpointVoiceResult =
  | { ok: true; voices: CloudVoiceCatalogEntry[] }
  | { ok: false; voices: [] };

/** Module-level endpoint cache. Keyed by `${baseUrl}|${apiKey}|${endpoint}`. */
const cache = new Map<string, EndpointCacheEntry>();

/** Combined catalog cache used only when both endpoint reads succeeded. */
const catalogCache = new Map<
  string,
  { fetchedAt: number; voices: CloudVoiceCatalogEntry[] }
>();

/**
 * Module-level singleflight. Keyed the same as {@link cache}; holds the
 * in-progress fetch so concurrent callers during a cache miss or a
 * remembered outage await the same upstream round trip instead of each
 * starting their own.
 */
const inflight = new Map<string, Promise<CloudVoiceCatalogEntry[]>>();

/**
 * Test seam: drop the in-memory cache. Production code should never call
 * this; the TTL handles eviction by itself.
 */
export function resetCloudVoiceCatalogCacheForTesting(): void {
  cache.clear();
  catalogCache.clear();
  inflight.clear();
}

function cacheKeyFor(runtime: IAgentRuntime): string {
  const baseUrl = getBaseURL(runtime) || "";
  const apiKey = getApiKey(runtime) || "";
  return `${baseUrl}|${apiKey}`;
}

function pickString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = record[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function pickStringFromAny(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const v = pickString(record, key);
    if (v) return v;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Best-effort normalizer for the heterogeneous shapes the upstream returns.
 *
 * ElevenLabs's premade voices include `labels: { gender, accent, ... }`,
 * `preview_url`, `category`. User-cloned voices look very similar but may
 * omit some fields. We accept any shape that has at least a `voice_id`
 * (or `id`) and produce a uniform record.
 */
function normalizeVoiceEntry(raw: unknown): CloudVoiceCatalogEntry | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = pickStringFromAny(record, "voice_id", "voiceId", "id");
  if (!id) return null;

  const name =
    pickStringFromAny(record, "name", "display_name", "displayName") ?? id;
  const preview = pickStringFromAny(
    record,
    "preview_url",
    "previewUrl",
    "preview",
  );
  const category = pickStringFromAny(record, "category");

  // `labels` is the canonical ElevenLabs metadata block.
  const labels = asRecord(record.labels);
  const gender =
    pickStringFromAny(record, "gender") ??
    (labels ? pickStringFromAny(labels, "gender") : undefined);
  const language =
    pickStringFromAny(record, "language", "language_code", "languageCode") ??
    (labels
      ? pickStringFromAny(labels, "language", "language_code", "languageCode")
      : undefined);

  return {
    id,
    name,
    ...(gender ? { gender } : {}),
    ...(preview ? { preview } : {}),
    ...(category ? { category } : {}),
    ...(language ? { language } : {}),
  };
}

/**
 * Some endpoints return `{ voices: [...] }`, others return a bare array.
 * Accept both.
 */
function extractVoiceArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of ["voices", "data", "items", "results"]) {
    const v = record[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function dedupeById(entries: CloudVoiceCatalogEntry[]): CloudVoiceCatalogEntry[] {
  const seen = new Set<string>();
  const out: CloudVoiceCatalogEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

async function fetchEndpointVoices(
  runtime: IAgentRuntime,
  endpoint: "premade" | "user",
): Promise<EndpointVoiceResult> {
  try {
    const client = clientFactory(runtime);
    const payload =
      endpoint === "premade"
        ? await client.routes.getApiElevenlabsVoices<unknown>()
        : await client.routes.getApiElevenlabsVoicesUser<unknown>();
    const raw = extractVoiceArray(payload);
    const normalized: CloudVoiceCatalogEntry[] = [];
    for (const entry of raw) {
      const v = normalizeVoiceEntry(entry);
      if (v) normalized.push(v);
    }
    return { ok: true, voices: normalized };
  } catch (err) {
    // error-policy:J4 one endpoint degrades to empty so the other still
    // populates the catalog (see fetchCloudVoiceCatalog); warn so a sustained
    // upstream outage is visible rather than buried as a silently-empty list.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[ELIZAOS_CLOUD] voice catalog ${endpoint} fetch failed: ${message}`,
    );
    return { ok: false, voices: [] };
  }
}

function endpointCacheKey(
  catalogKey: string,
  endpoint: "premade" | "user"
): string {
  return `${catalogKey}|${endpoint}`;
}

async function loadEndpointVoices(
  runtime: IAgentRuntime,
  catalogKey: string,
  endpoint: "premade" | "user"
): Promise<EndpointVoiceResult> {
  const key = endpointCacheKey(catalogKey, endpoint);
  const cached = cache.get(key);
  const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
  if (cached?.kind === "success" && age < CACHE_TTL_MS) {
    return { ok: true, voices: cached.voices };
  }
  if (cached?.kind === "failure" && age < FAILURE_TTL_MS) {
    return { ok: false, voices: [] };
  }

  const result = await fetchEndpointVoices(runtime, endpoint);
  cache.set(
    key,
    result.ok
      ? { kind: "success", fetchedAt: Date.now(), voices: result.voices }
      : { kind: "failure", fetchedAt: Date.now() }
  );
  return result;
}

/**
 * Fetch the user-visible voice catalog from Eliza Cloud (premade + cloned).
 *
 * Returns an empty array when:
 *   - Cloud TTS isn't available (no API key, or neither
 *     `ELIZAOS_CLOUD_ENABLED` nor `ELIZAOS_CLOUD_USE_TTS` is set — the same
 *     gate as the TEXT_TO_SPEECH handler, so the catalog serves in
 *     capability-only mode too).
 *   - Both upstream endpoints fail (network, auth, etc.).
 *
 * Successful endpoint results are cached independently for
 * {@link CACHE_TTL_MS}; endpoint failures use {@link FAILURE_TTL_MS}. This
 * keeps a healthy premade catalog warm while retrying a failed user-voice
 * endpoint quickly instead of hiding newly available clones for an hour. A
 * total outage is reported via `runtime.reportError` so it remains observable
 * rather than indistinguishable from a genuinely empty catalog.
 */
export async function fetchCloudVoiceCatalog(
  runtime: IAgentRuntime,
): Promise<CloudVoiceCatalogEntry[]> {
  if (!isCloudTtsAvailable(runtime)) {
    return [];
  }
  const key = cacheKeyFor(runtime);
  const combined = catalogCache.get(key);
  if (combined && Date.now() - combined.fetchedAt < CACHE_TTL_MS) {
    return combined.voices;
  }

  // Concurrent callers during a miss or an endpoint retry share this one
  // catalog load instead of racing the per-endpoint cache checks.
  const existing = inflight.get(key);
  if (existing) {
    return existing;
  }

  const promise = (async (): Promise<CloudVoiceCatalogEntry[]> => {
    const [premade, user] = await Promise.all([
      loadEndpointVoices(runtime, key, "premade"),
      loadEndpointVoices(runtime, key, "user"),
    ]);

    // User voices first so cloned voices appear before the shared premade
    // list — most users care about their own clones.
    const merged = dedupeById([...user.voices, ...premade.voices]);
    if (premade.ok && user.ok) {
      catalogCache.set(key, { fetchedAt: Date.now(), voices: merged });
      return merged;
    }
    if (premade.ok || user.ok) return merged;

    // Total outage: both endpoint caches carry short-lived failure entries;
    // surface it observably (error-policy: "not loaded" must never read as
    // "empty").
    runtime.reportError(
      "cloud-voice-catalog",
      new Error("cloud voice catalog: both premade and user endpoints failed"),
      { baseUrl: getBaseURL(runtime) || undefined },
    );
    return merged;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}
