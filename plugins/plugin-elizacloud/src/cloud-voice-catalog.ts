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
 * test-isolated runtimes don't share entries. On any fetch error we return
 * a normalized empty list rather than throwing — callers can decide whether
 * to surface a UI hint.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { isCloudConnected, logger, toRuntimeSettings } from "@elizaos/core";
import { getApiKey, getBaseURL } from "./utils/config";
import { createElizaCloudClient } from "./utils/sdk-client";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
  createElizaCloudClient(runtime) as unknown as CloudVoiceClient;

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
      createElizaCloudClient(runtime) as unknown as CloudVoiceClient;
  } else {
    clientFactory = factory;
  }
}

interface CacheEntry {
  fetchedAt: number;
  voices: CloudVoiceCatalogEntry[];
}

/** Module-level cache. Keyed by `${baseUrl}|${apiKey}`. */
const cache = new Map<string, CacheEntry>();

/**
 * Test seam: drop the in-memory cache. Production code should never call
 * this; the TTL handles eviction by itself.
 */
export function resetCloudVoiceCatalogCacheForTesting(): void {
  cache.clear();
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
): Promise<CloudVoiceCatalogEntry[]> {
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
    return normalized;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(
      `[ELIZAOS_CLOUD] voice catalog ${endpoint} fetch failed: ${message}`,
    );
    return [];
  }
}

/**
 * Fetch the user-visible voice catalog from Eliza Cloud (premade + cloned).
 *
 * Returns an empty array when:
 *   - Eliza Cloud isn't connected (no API key / not enabled).
 *   - Both upstream endpoints fail (network, auth, etc.).
 *
 * Results are cached for {@link CACHE_TTL_MS} per runtime. Subsequent calls
 * within that window are served from memory.
 */
export async function fetchCloudVoiceCatalog(
  runtime: IAgentRuntime,
): Promise<CloudVoiceCatalogEntry[]> {
  if (!isCloudConnected(toRuntimeSettings(runtime))) {
    return [];
  }
  const key = cacheKeyFor(runtime);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.voices;
  }

  const [premade, user] = await Promise.all([
    fetchEndpointVoices(runtime, "premade"),
    fetchEndpointVoices(runtime, "user"),
  ]);

  // User voices first so cloned voices appear before the shared premade
  // list — most users care about their own clones.
  const merged = dedupeById([...user, ...premade]);
  cache.set(key, { fetchedAt: now, voices: merged });
  return merged;
}
