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
  }
}

export interface DirectApiProbeResult {
  ok: boolean;
  status: number;
  error?: string;
  latencyMs: number;
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
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        error: `${providerId} ${response.status}: ${text.slice(0, 200)}`,
        latencyMs,
      };
    }
    return { ok: true, status: response.status, latencyMs };
  } catch (err) {
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
