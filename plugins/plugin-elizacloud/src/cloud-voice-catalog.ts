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

type CacheEntry =
  | { kind: "success"; fetchedAt: number; voices: CloudVoiceCatalogEntry[] }
  | { kind: "failure"; fetchedAt: number };

type EndpointVoiceResult =
  | { ok: true; voices: CloudVoiceCatalogEntry[] }
  | { ok: false; voices: [] };

/** Module-level cache. Keyed by `${baseUrl}|${apiKey}`. */
const cache = new Map<string, CacheEntry>();

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
 * Results are cached for {@link CACHE_TTL_MS} per runtime. Subsequent calls
 * within that window are served from memory. A total outage (both endpoints
 * fail) is remembered for {@link FAILURE_TTL_MS} instead — long enough to
 * shield upstream from a thundering herd of retries, short enough to pick up
 * a real recovery quickly — and is reported via `runtime.reportError` so the
 * outage is observable rather than indistinguishable from a genuinely empty
 * catalog.
 */
export async function fetchCloudVoiceCatalog(
  runtime: IAgentRuntime,
): Promise<CloudVoiceCatalogEntry[]> {
  if (!isCloudTtsAvailable(runtime)) {
    return [];
  }
  const key = cacheKeyFor(runtime);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached) {
    if (cached.kind === "success" && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.voices;
    }
    if (cached.kind === "failure" && now - cached.fetchedAt < FAILURE_TTL_MS) {
      return [];
    }
  }

  // Concurrent callers during a miss or a remembered outage share this one
  // upstream fetch pair instead of each firing their own (singleflight).
  const existing = inflight.get(key);
  if (existing) {
    return existing;
  }

  const promise = (async (): Promise<CloudVoiceCatalogEntry[]> => {
    const [premade, user] = await Promise.all([
      fetchEndpointVoices(runtime, "premade"),
      fetchEndpointVoices(runtime, "user"),
    ]);

    // User voices first so cloned voices appear before the shared premade
    // list — most users care about their own clones.
    const merged = dedupeById([...user.voices, ...premade.voices]);
    if (premade.ok || user.ok) {
      cache.set(key, { kind: "success", fetchedAt: Date.now(), voices: merged });
      return merged;
    }

    // Total outage: both endpoints failed. Never cache this as a genuine
    // empty catalog — record a short-lived failure entry instead and surface
    // the outage observably (error-policy: "not loaded" must never read as
    // "empty").
    cache.set(key, { kind: "failure", fetchedAt: Date.now() });
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
