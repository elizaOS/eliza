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
export const REAL_LLM_MODEL = "cerebras/gemma-4-31b";

/** Billing source + provider for {@link REAL_LLM_MODEL} (seed-pricing). */
export const REAL_LLM_BILLING_SOURCE = "cerebras";

/**
 * The model's max output tokens (gemma-4-31b on Cerebras: 40000 on the paid
 * tier, per the `CEREBRAS_DEFAULT_TEXT_SMALL_MODEL` catalog entry in
 * cloud/shared/lib/models/catalog.ts). gemma-4-31b is non-reasoning by default
 * (reasoning only via `reasoning_effort`), but still give it the model's full
 * output budget so long completions are never truncated.
 */
export const REAL_LLM_MAX_TOKENS = 40000;

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
