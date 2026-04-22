/**
 * Probes configured local AI engine endpoints for the Local models hub and provider list.
 *
 * **WHY this exists (and what it is *not*):** Operators often run a separate local
 * inference server alongside Milady. Lightweight HTTP checks give the UI
 * reachability, endpoints, and model id lists so env hints match reality.
 * These probes are **discovery for humans/diagnostics** and also set
 * `routerInferenceReady` per row for `isExternalLocalLlmInferenceReady(focus)`:
 * Ollama uses **`/api/ps`** when available so we only treat **running**
 * models as “external intelligence is hot” (falls back to tags-only when `/api/ps`
 * is missing). LM Studio also probes **`GET /api/v1/models`** and sums
 * **`loaded_instances`** (UI load/eject) when that parses; vLLM and **Jan**
 * use **`/v1/models`** only (Jan defaults to **1337**, optional **`JAN_API_KEY`**
 * bearer). With **`focus === "any"`** (default), the router skips in-app GGUF when
 * **any** row is ready **and** another handler exists; a concrete **`focus`**
 * limits that gate to one stack (see `routing-preferences.externalLlmAutodetectFocus`
 * and `docs/runtime/self-hosted-llm-inference-whys.md` §4).
 *
 * Duplicates the logic in `@elizaos/core/testing` so `@elizaos/app-core` does not
 * depend on the `testing` subpath (Vitest/tsconfig resolution breaks on it).
 */

import z from "zod";

import {
  EXTERNAL_LLM_PROBE_ORDER,
  externalLocalLlmRowReadyForGguf,
} from "./external-llm-autodetect";
import type {
  ExternalLlmAutodetectFocus,
  ExternalLlmRuntimeRow,
} from "./types";

export type ExternalProbeBackendId = ExternalLlmRuntimeRow["id"];

type LocalLlmProbeEnv = Record<string, string | undefined>;

export type ProbedLlmBackend = ExternalLlmRuntimeRow;

const PROBE_TIMEOUT_MS = 5000;

const ollamaTagsModelSchema = z.object({
  name: z.string(),
  remote_model: z.string().optional(),
  remote_host: z.string().optional(),
  size: z.number().optional(),
});

const ollamaTagsResponseSchema = z.object({
  models: z.array(ollamaTagsModelSchema).optional(),
});

const ollamaPsResponseSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string().optional(),
        model: z.string().optional(),
      }),
    )
    .optional(),
});

const openAiModelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string() })).optional(),
});

/** LM Studio native list — `loaded_instances` reflects UI load / eject state. */
const lmStudioNativeListSchema = z.object({
  models: z
    .array(
      z.object({
        loaded_instances: z.array(z.unknown()).optional(),
      }),
    )
    .optional(),
});

function sumLmStudioLoadedInstances(
  data: z.infer<typeof lmStudioNativeListSchema>,
): number {
  let total = 0;
  for (const m of data.models ?? []) {
    total += m.loaded_instances?.length ?? 0;
  }
  return total;
}

let cache: { at: number; data: ProbedLlmBackend[] } | null = null;
const TTL_MS = 4000;

function readEnv(env: LocalLlmProbeEnv, key: string): string | undefined {
  return env[key]?.trim() || undefined;
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function getOllamaProbeBaseUrl(env: LocalLlmProbeEnv): string {
  const fromEnv =
    readEnv(env, "OLLAMA_BASE_URL") ||
    readEnv(env, "OLLAMA_URL") ||
    "http://localhost:11434";
  return trimTrailingSlashes(fromEnv);
}

function getLmStudioProbeBaseUrl(env: LocalLlmProbeEnv): string {
  const fromEnv = readEnv(env, "LM_STUDIO_BASE_URL") || "http://127.0.0.1:1234";
  return trimTrailingSlashes(fromEnv);
}

function getVllmProbeBaseUrl(env: LocalLlmProbeEnv): string {
  const fromEnv =
    readEnv(env, "VLLM_BASE_URL") ||
    readEnv(env, "VLLM_API_BASE") ||
    readEnv(env, "VLLM_OPENAI_API_BASE") ||
    "http://127.0.0.1:8000";
  return trimTrailingSlashes(fromEnv);
}

function getJanProbeBaseUrl(env: LocalLlmProbeEnv): string {
  const fromEnv =
    readEnv(env, "JAN_BASE_URL") ||
    readEnv(env, "JAN_SERVER_URL") ||
    readEnv(env, "JAN_API_BASE") ||
    "http://127.0.0.1:1337";
  return trimTrailingSlashes(fromEnv);
}

function resolveOpenAiCompatibleModelsUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlashes(baseUrl);
  const v1Root = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  return `${v1Root}/models`;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function invalidateExternalLlmRuntimeCache(): void {
  cache = null;
}

async function probeOllama(env: LocalLlmProbeEnv): Promise<ProbedLlmBackend> {
  const endpoint = getOllamaProbeBaseUrl(env);
  const id: ExternalProbeBackendId = "ollama";
  const displayName = "Ollama";

  const fail = (error: string): ProbedLlmBackend => ({
    id,
    displayName,
    reachable: false,
    endpoint,
    models: [],
    hasDownloadedModels: false,
    routerInferenceReady: false,
    error,
  });

  try {
    const [tagsRes, psRes] = await Promise.all([
      fetch(`${endpoint}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }),
      fetch(`${endpoint}/api/ps`, {
        method: "GET",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }),
    ]);

    if (!tagsRes.ok) {
      return fail(`HTTP ${tagsRes.status}`);
    }

    const rawTags = await safeJson(tagsRes);
    const parsed = ollamaTagsResponseSchema.safeParse(rawTags);
    if (!parsed.success) {
      return fail("Unexpected JSON from /api/tags");
    }

    const rawModels = parsed.data.models ?? [];
    const models = rawModels.map((m) => m.name);
    const ollamaLocalModelNames = rawModels
      .filter((m) => {
        if (m.remote_model?.trim()) return false;
        if (m.remote_host?.trim()) return false;
        if (typeof m.size === "number" && m.size <= 0) return false;
        return true;
      })
      .map((m) => m.name);
    const hasPulls = models.length > 0;

    let ollamaRunningModelCount: number | undefined;
    let psKnown = false;
    if (psRes.ok) {
      const psRaw = await safeJson(psRes);
      const psParsed = ollamaPsResponseSchema.safeParse(psRaw);
      if (psParsed.success) {
        psKnown = true;
        ollamaRunningModelCount = psParsed.data.models?.length ?? 0;
      }
    }

    /** Cold library (ps = 0) → do not tell the router external RAM is hot yet. */
    const routerInferenceReady =
      hasPulls && (!psKnown || (ollamaRunningModelCount ?? 0) > 0);

    return {
      id,
      displayName,
      reachable: true,
      endpoint,
      models,
      ollamaLocalModelNames,
      hasDownloadedModels: hasPulls,
      ...(typeof ollamaRunningModelCount === "number"
        ? { ollamaRunningModelCount }
        : {}),
      routerInferenceReady,
    };
  } catch (error) {
    return {
      id,
      displayName,
      reachable: false,
      endpoint,
      models: [],
      hasDownloadedModels: false,
      routerInferenceReady: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function probeOpenAiCompatibleModels(options: {
  id: ExternalProbeBackendId;
  displayName: string;
  endpoint: string;
  apiKey?: string;
}): Promise<ProbedLlmBackend> {
  const { id, displayName, endpoint, apiKey } = options;
  const modelsUrl = resolveOpenAiCompatibleModelsUrl(endpoint);

  const fail = (error: string): ProbedLlmBackend => ({
    id,
    displayName,
    reachable: false,
    endpoint,
    models: [],
    hasDownloadedModels: false,
    routerInferenceReady: false,
    error,
  });

  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    if (id === "lmstudio") {
      const nativeUrl = `${trimTrailingSlashes(endpoint)}/api/v1/models`;
      const [openAiRes, nativeRes] = await Promise.all([
        fetch(modelsUrl, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        }),
        fetch(nativeUrl, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        }),
      ]);

      if (!openAiRes.ok) {
        return fail(`HTTP ${openAiRes.status}`);
      }

      const rawOpen = await safeJson(openAiRes);
      const parsedOpen = openAiModelsResponseSchema.safeParse(rawOpen);
      if (!parsedOpen.success) {
        return fail("Unexpected JSON from /v1/models");
      }

      const models = parsedOpen.data.data?.map((m) => m.id) ?? [];
      const hasModels = models.length > 0;

      let lmStudioLoadedInstanceCount: number | undefined;
      let routerInferenceReady = hasModels;
      if (nativeRes.ok) {
        const rawNative = await safeJson(nativeRes);
        const parsedNative = lmStudioNativeListSchema.safeParse(rawNative);
        if (parsedNative.success) {
          const loaded = sumLmStudioLoadedInstances(parsedNative.data);
          lmStudioLoadedInstanceCount = loaded;
          routerInferenceReady = hasModels && loaded > 0;
        }
      }

      return {
        id,
        displayName,
        reachable: true,
        endpoint,
        models,
        hasDownloadedModels: hasModels,
        ...(lmStudioLoadedInstanceCount !== undefined
          ? { lmStudioLoadedInstanceCount }
          : {}),
        routerInferenceReady,
      };
    }

    const response = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (!response.ok) {
      return fail(`HTTP ${response.status}`);
    }

    const raw = await safeJson(response);
    const parsed = openAiModelsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return fail("Unexpected JSON from /v1/models");
    }

    const models = parsed.data.data?.map((m) => m.id) ?? [];
    const hasModels = models.length > 0;
    return {
      id,
      displayName,
      reachable: true,
      endpoint,
      models,
      hasDownloadedModels: hasModels,
      routerInferenceReady: hasModels,
    };
  } catch (error) {
    return {
      id,
      displayName,
      reachable: false,
      endpoint,
      models: [],
      hasDownloadedModels: false,
      routerInferenceReady: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/** Uncached parallel probe — pass `env` for doctor / tests (defaults to `process.env`). */
export async function detectExternalLlmBackends(
  env: LocalLlmProbeEnv = process.env,
): Promise<ProbedLlmBackend[]> {
  const lmStudioKey =
    readEnv(env, "LM_STUDIO_API_KEY") || readEnv(env, "LMSTUDIO_API_KEY");
  const janKey =
    readEnv(env, "JAN_API_KEY") || readEnv(env, "JAN_LOCAL_API_KEY");

  const [ollama, lmstudio, vllm, jan] = await Promise.all([
    probeOllama(env),
    probeOpenAiCompatibleModels({
      id: "lmstudio",
      displayName: "LM Studio",
      endpoint: getLmStudioProbeBaseUrl(env),
      apiKey: lmStudioKey,
    }),
    probeOpenAiCompatibleModels({
      id: "vllm",
      displayName: "vLLM",
      endpoint: getVllmProbeBaseUrl(env),
    }),
    probeOpenAiCompatibleModels({
      id: "jan",
      displayName: "Jan",
      endpoint: getJanProbeBaseUrl(env),
      apiKey: janKey,
    }),
  ]);

  const byId = {
    ollama,
    lmstudio,
    vllm,
    jan,
  } as const;
  return EXTERNAL_LLM_PROBE_ORDER.map((id) => byId[id]);
}

/**
 * Cached probes for the hub + provider matrix. Pass `force: true` to bypass TTL.
 */
export async function snapshotExternalLlmRuntimes(
  force = false,
): Promise<ProbedLlmBackend[]> {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) {
    return cache.data;
  }
  const data = await detectExternalLlmBackends();
  cache = { at: now, data };
  return data;
}

/**
 * True when some probed row in **`focus`**’s pool has **`routerInferenceReady`**
 * (see `probeOllama` / `probeOpenAiCompatibleModels`). **`focus === "any"`** uses
 * every row; a stack id uses only that row. Ollama prefers **`/api/ps`** so we
 * only treat **running** models as hot when that endpoint works; LM Studio adds
 * **`/api/v1/models`** `loaded_instances` when it parses; vLLM and Jan use listed
 * `/v1/models` ids (Jan: **`JAN_API_KEY`** bearer or probes return 401).
 * **`focus === "milady-gguf"`** always returns **`false`** (HTTP stacks ignored).
 */
export async function isExternalLocalLlmInferenceReady(
  focus: ExternalLlmAutodetectFocus = "any",
): Promise<boolean> {
  if (focus === "milady-gguf") {
    return false;
  }
  const backends = await snapshotExternalLlmRuntimes(false);
  const pool =
    focus === "any" ? backends : backends.filter((b) => b.id === focus);
  return pool.some((b) => externalLocalLlmRowReadyForGguf(b));
}
