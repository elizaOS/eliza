/**
 * Verifies direct-provider credentials with bounded diagnostics and catalogs.
 * OpenRouter authentication uses its current-key endpoint because the public
 * model catalog does not prove credential ownership; new account providers
 * never reflect their untrusted failure bodies across the enrollment boundary.
 */
import type { DirectAccountProvider } from "./types.ts";

/** Provider base URL for a direct-API key, honoring the *_BASE_URL overrides. */
export function directProviderBaseUrl(
  providerId: DirectAccountProvider,
): string {
  switch (providerId) {
    case "anthropic-api":
      return (
        process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com/v1"
      );
    case "openai-api":
      return process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
    case "deepseek-api":
      return (
        process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com"
      );
    case "zai-api":
      return (
        process.env.ZAI_BASE_URL?.trim() ||
        process.env.Z_AI_BASE_URL?.trim() ||
        "https://api.z.ai/api/paas/v4"
      );
    case "moonshot-api":
      return (
        process.env.MOONSHOT_BASE_URL?.trim() ||
        process.env.KIMI_BASE_URL?.trim() ||
        "https://api.moonshot.ai/v1"
      );
    case "cerebras-api":
      return (
        process.env.CEREBRAS_BASE_URL?.trim() || "https://api.cerebras.ai/v1"
      );
    case "openrouter-api":
      return (
        process.env.OPENROUTER_BASE_URL?.trim() ||
        "https://openrouter.ai/api/v1"
      );
    case "xai-api":
      return process.env.XAI_BASE_URL?.trim() || "https://api.x.ai/v1";
  }
}

export interface DirectApiProbeResult {
  ok: boolean;
  status: number;
  error?: string;
  latencyMs: number;
  /** Complete provider catalog within the response-size safety bound. */
  modelIds?: string[];
  /** True when the provider response exceeded the byte safety bound. */
  modelCatalogTruncated?: boolean;
}

const MAX_MODEL_CATALOG_BYTES = 1_048_576;
const MAX_PROBE_FAILURE_BODY_BYTES = 64 * 1024;

async function readProbeFailureBody(response: Response): Promise<string> {
  try {
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_PROBE_FAILURE_BODY_BYTES
    ) {
      return `[response body rejected: ${declaredLength} bytes exceeds the ${MAX_PROBE_FAILURE_BODY_BYTES}-byte probe diagnostic limit]`;
    }
    if (!response.body) {
      const body = await response.text();
      const bytes = new TextEncoder().encode(body);
      if (bytes.length <= MAX_PROBE_FAILURE_BODY_BYTES) return body;
      return `[response body rejected: ${bytes.length} bytes exceeds the ${MAX_PROBE_FAILURE_BODY_BYTES}-byte probe diagnostic limit]`;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_PROBE_FAILURE_BODY_BYTES) {
        await reader.cancel();
        return `[response body rejected: more than ${MAX_PROBE_FAILURE_BODY_BYTES} bytes exceeds the probe diagnostic limit]`;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch (cause) {
    // error-policy:J4 explicit diagnostic degrade — the HTTP status remains the
    // authoritative failed probe; only the optional provider body is unavailable.
    return `[response body unavailable: ${cause instanceof Error ? cause.message : String(cause)}]`;
  }
}

async function readBoundedResponseText(
  response: Response,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (total + next.value.byteLength > MAX_MODEL_CATALOG_BYTES) {
      await reader.cancel();
      return { text: "", truncated: true };
    }
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated: false };
}

function parseBoundedModelIds(text: string): {
  modelIds?: string[];
  truncated: boolean;
} {
  if (!text) return { truncated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // error-policy:J3 provider catalog JSON is untrusted. A malformed optional
    // catalog does not turn a successful authenticated probe into fake models.
    return { truncated: false };
  }
  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    return { truncated: false };
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) return { truncated: false };
  const unique = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const normalized = id.trim();
    if (!normalized || normalized.length > 256) continue;
    unique.add(normalized);
  }
  return {
    ...(unique.size > 0 ? { modelIds: [...unique] } : {}),
    truncated: false,
  };
}

async function readModelCatalog(response: Response): Promise<{
  modelIds?: string[];
  modelCatalogTruncated?: true;
}> {
  if (!response.ok) return {};
  const catalogBody = await readBoundedResponseText(response);
  const catalog = catalogBody.truncated
    ? { truncated: true }
    : parseBoundedModelIds(catalogBody.text);
  return {
    ...(catalog.modelIds ? { modelIds: catalog.modelIds } : {}),
    ...(catalog.truncated ? { modelCatalogTruncated: true as const } : {}),
  };
}

async function fetchOpenRouterCatalog(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ modelIds?: string[]; modelCatalogTruncated?: true }> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      signal,
    });
    return await readModelCatalog(response);
  } catch {
    // error-policy:J4 The public catalog is optional metadata after the
    // authenticated current-key check has already established account health.
    return {};
  }
}

/**
 * Verify a direct-API key against a provider-owned authenticated endpoint.
 * OpenRouter uses `/key` and only then reads its public `/models` catalog;
 * other providers authenticate through `/models` directly.
 */
export async function probeDirectApiKey(
  providerId: DirectAccountProvider,
  apiKey: string,
): Promise<DirectApiProbeResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const baseUrl = directProviderBaseUrl(providerId).replace(/\/+$/, "");
    const response =
      providerId === "anthropic-api"
        ? await fetch(`${baseUrl}/models?limit=1`, {
            method: "GET",
            signal: controller.signal,
            headers: {
              "anthropic-version": "2023-06-01",
              "x-api-key": apiKey,
            },
          })
        : await fetch(
            `${baseUrl}/${providerId === "openrouter-api" ? "key" : "models"}`,
            {
              method: "GET",
              signal: controller.signal,
              headers: {
                Authorization: `Bearer ${apiKey}`,
              },
            },
          );
    if (!response.ok) {
      const preserveProviderDiagnostic =
        providerId !== "openrouter-api" && providerId !== "xai-api";
      const diagnostic = preserveProviderDiagnostic
        ? `: ${await readProbeFailureBody(response)}`
        : "";
      return {
        ok: false,
        status: response.status,
        // Provider bodies are untrusted and have historically included request
        // diagnostics. Never reflect one across the account API boundary where
        // it could echo credentials into UI state, logs, or evidence.
        error: preserveProviderDiagnostic
          ? `${providerId} ${response.status}${diagnostic}`
          : `${providerId} credential probe failed (HTTP ${response.status})`,
        latencyMs: Date.now() - start,
      };
    }
    const catalog =
      providerId === "openrouter-api"
        ? await fetchOpenRouterCatalog(baseUrl, controller.signal)
        : await readModelCatalog(response);
    return {
      ok: true,
      status: response.status,
      latencyMs: Date.now() - start,
      ...(catalog.modelIds ? { modelIds: catalog.modelIds } : {}),
      ...(catalog.modelCatalogTruncated ? { modelCatalogTruncated: true } : {}),
    };
  } catch (err) {
    // error-policy:J1 boundary translation — callers need a typed failed probe
    // for transport/timeout failures, distinct from an authenticated HTTP status.
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}
