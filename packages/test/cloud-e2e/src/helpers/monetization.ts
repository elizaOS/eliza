/**
 * Shared helpers for the creator-monetization e2e specs.
 */

export interface AuthedResponse<T> {
  status: number;
  json: T;
}

/**
 * Build an authenticated JSON fetch bound to a stack API base + API key.
 * Sends both `Authorization: Bearer <key>` and `X-API-Key: <key>` (the routes
 * accept either). Extra headers (e.g. `X-App-Id`, `X-Affiliate-Code`) merge in.
 */
export function authedClient(api: string, apiKey: string) {
  return async function authed<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<AuthedResponse<T>> {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-API-Key": apiKey,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}) as T)) as T;
    return { status: res.status, json };
  };
}

/**
 * The cloud's DEFAULT text model — routed natively to Cerebras
 * (`CEREBRAS_DEFAULT_TEXT_SMALL_MODEL`). The `cerebras/` prefix makes
 * `resolveAiProviderSource` bill it to the `cerebras` source and the language
 * model layer call `api.cerebras.ai/v1`. No Ollama / local-OpenAI shim.
 */
export const REAL_LLM_MODEL = "cerebras/gpt-oss-120b";

/** Billing source + provider for {@link REAL_LLM_MODEL} (seed-pricing). */
export const REAL_LLM_BILLING_SOURCE = "cerebras";

/**
 * The model's max output tokens (gpt-oss-120b on Cerebras: 40960, per the
 * `CEREBRAS_DEFAULT_TEXT_SMALL_MODEL` catalog entry in
 * cloud-shared/lib/models/catalog.ts). gpt-oss-120b is a reasoning model, so a
 * small cap is spent entirely on reasoning and returns empty content — give it
 * the model's full output budget.
 */
export const REAL_LLM_MAX_TOKENS = 40960;

/**
 * Whether the cloud's default inference provider (Cerebras) is configured.
 * The real-LLM marquee lane runs against it; when CEREBRAS_API_KEY is absent it
 * skips loudly rather than larp a fake completion — and never falls back to a
 * local provider. Export the key so it reaches BOTH this gate (test process)
 * and the booted worker (the cloud-api dev wrapper syncs it into .dev.vars; see
 * `providerOverrideKeys` in scripts/cloud/admin/sync-api-dev-vars.ts).
 */
export function cerebrasConfigured(): boolean {
  return Boolean(process.env.CEREBRAS_API_KEY?.trim());
}
