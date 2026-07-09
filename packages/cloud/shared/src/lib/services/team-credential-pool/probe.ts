/**
 * Live pre-pool probe for contributed API keys (#11332).
 *
 * Patterned byte-for-byte on `packages/agent/src/auth/direct-api-probe.ts`
 * (`probeDirectApiKey`, the #11033 verify-before-evict pattern) but local to
 * cloud-shared: importing @elizaos/agent would drag its node-only auth stack
 * into the Cloudflare Worker bundle for ~60 lines of pure fetch. Keep the two
 * in sync when adding a provider.
 *
 * `ok` is true only on a 2xx from a minimal authed GET (`/models`); a 401/403
 * (revoked/invalid key) returns `ok: false` with the status so the route can
 * reject the contribution before it ever enters rotation.
 */

import { getCloudAwareEnv } from "../../runtime/cloud-bindings";
import { logger } from "../../utils/logger";
import type { PooledDirectProvider } from "./provider-map";

export function pooledProviderBaseUrl(providerId: PooledDirectProvider): string {
  const env = getCloudAwareEnv();
  switch (providerId) {
    case "anthropic-api":
      return env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com/v1";
    case "openai-api":
      return env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
    case "deepseek-api":
      return env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
    case "zai-api":
      return (
        env.ZAI_BASE_URL?.trim() || env.Z_AI_BASE_URL?.trim() || "https://api.z.ai/api/paas/v4"
      );
    case "moonshot-api":
      return (
        env.MOONSHOT_BASE_URL?.trim() || env.KIMI_BASE_URL?.trim() || "https://api.moonshot.ai/v1"
      );
    case "cerebras-api":
      return env.CEREBRAS_BASE_URL?.trim() || "https://api.cerebras.ai/v1";
  }
}

export interface PooledApiProbeResult {
  ok: boolean;
  status: number;
  error?: string;
  latencyMs: number;
}

export async function probePooledApiKey(
  providerId: PooledDirectProvider,
  apiKey: string,
): Promise<PooledApiProbeResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const baseUrl = pooledProviderBaseUrl(providerId).replace(/\/+$/, "");
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
      // error-policy:J1 the non-2xx HTTP status is the load-bearing failure
      // signal (drives fail-closed rejection at contribution and needs-reauth at
      // keep-alive); reading the optional provider error body is best-effort and
      // must not clobber that status by throwing out of this branch.
      const text = await response.text().catch((error) => {
        logger.warn("[team-credential-pool] Failed to read pooled API probe error body", {
          providerId,
          status: response.status,
          error: error instanceof Error ? error.message : String(error),
        });
        return "";
      });
      return {
        ok: false,
        status: response.status,
        error: `${providerId} ${response.status}: ${text.slice(0, 200)}`,
        latencyMs,
      };
    }
    return { ok: true, status: response.status, latencyMs };
  } catch (err) {
    // error-policy:J1 boundary translation of a transport failure (fetch reject,
    // DNS/TLS error, or the 10s AbortController timeout) into a structured probe
    // failure. `ok:false` is a genuine failure — never a fabricated success:
    // contribution (service.ts) rejects fail-closed on it, and keep-alive
    // (registry.ts) treats status:0 as a transient and leaves credential health
    // untouched rather than flagging a healthy key on a network blip.
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
