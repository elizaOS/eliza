// Direct-API key server-side probe. Extracted from the accounts route
// (#11033 follow-up) so the coding-account bridge can verify a pooled
// direct-API credential against the provider — a locally-stored key with the
// never-expires sentinel resolves fine offline, so a cached-but-revoked key
// can only be caught by an authed round-trip.
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
  /** Bounded provider catalog sample; credential material is never included. */
  modelIds?: string[];
  /** True when the provider response exceeded a catalog safety bound. */
  modelCatalogTruncated?: boolean;
}

const MAX_MODEL_CATALOG_BYTES = 1_048_576;
const MAX_DISCOVERED_MODELS = 100;

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
    if (unique.size === MAX_DISCOVERED_MODELS) break;
  }
  return {
    ...(unique.size > 0 ? { modelIds: [...unique] } : {}),
    truncated: data.length > MAX_DISCOVERED_MODELS,
  };
}

/**
 * Verify a direct-API key against the provider with a minimal authed GET
 * (`/models`). `ok` is true only on a 2xx; a 401/403 (revoked/invalid) returns
 * `ok:false` with the status so the caller can mark the account needs-reauth.
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
        : await fetch(`${baseUrl}/models`, {
            method: "GET",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
          });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        // Provider bodies are untrusted and have historically included request
        // diagnostics. Never reflect one across the account API boundary where
        // it could echo credentials into UI state, logs, or evidence.
        error: `${providerId} credential probe failed (HTTP ${response.status})`,
        latencyMs,
      };
    }
    const catalogBody = await readBoundedResponseText(response);
    const catalog = catalogBody.truncated
      ? { truncated: true }
      : parseBoundedModelIds(catalogBody.text);
    return {
      ok: true,
      status: response.status,
      latencyMs,
      ...(catalog.modelIds ? { modelIds: catalog.modelIds } : {}),
      ...(catalog.truncated ? { modelCatalogTruncated: true } : {}),
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
