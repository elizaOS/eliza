/**
 * Shared helpers for the creator-monetization e2e specs.
 */

import { appsService } from "@elizaos/cloud-shared/lib/services/apps";

export interface AuthedResponse<T> {
  status: number;
  json: T;
}

export type AuthedClient = ReturnType<typeof authedClient>;

/**
 * Poll an eventually-consistent billing/read-model assertion without sleeping
 * blindly. Worker `waitUntil` settlement is intentionally allowed to finish
 * after the inference response has been returned to the caller.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  accepted: (value: T) => boolean,
  description: string,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let latest = await read();
  while (!accepted(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    latest = await read();
  }
  if (!accepted(latest)) {
    throw new Error(`Timed out waiting for ${description}`);
  }
  return latest;
}

const INFERENCE_WARMING_MESSAGES = new Set([
  "Authorization cache is warming. Retry shortly.",
  "Rate-limit authorization cache is warming. Retry shortly.",
  "Application authorization cache is warming. Retry shortly.",
  "Moderation authorization cache is warming. Retry shortly.",
  "Billing authorization is warming. Retry shortly.",
]);

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
 * Open the app review gate after a monetization spec has proved drafts are
 * rejected. Use the service boundary so its read caches cannot retain the
 * draft row after this deterministic test-only approval.
 */
export async function approveAppForMonetizationTest(
  appId: string,
  client: AuthedClient,
): Promise<void> {
  const approved = await appsService.update(appId, {
    review_status: "approved",
    review_content_hash: null,
    reviewed_at: new Date(),
  });

  if (!approved) {
    throw new Error(`Cannot approve missing monetization test app: ${appId}`);
  }

  // The e2e test and API Worker are separate processes. Cross the API boundary
  // with a benign update so the Worker's appsService evicts its cached draft.
  const cacheBust = await client("PATCH", `/api/v1/apps/${appId}`, {
    logo_url: "https://example.com/monetization-test-app.png",
  });
  if (cacheBust.status !== 200) {
    throw new Error(
      `Cannot invalidate monetization test app cache: ${appId} (${cacheBust.status})`,
    );
  }
}

/**
 * Retry only the gateway's explicit cache-warming response. A cold Worker can
 * hydrate several independent inference caches in sequence; provider failures
 * and every other 503 remain immediate test failures.
 */
export async function retryInferenceCacheWarming<T>(
  request: () => Promise<AuthedResponse<T>>,
  maxAttempts = 8,
): Promise<AuthedResponse<T>> {
  let response = await request();
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    if (!isInferenceCacheWarming(response)) return response;
    await new Promise((resolve) => setTimeout(resolve, 100));
    response = await request();
  }
  return response;
}

function isInferenceCacheWarming(response: AuthedResponse<unknown>): boolean {
  if (
    response.status !== 503 ||
    !response.json ||
    typeof response.json !== "object"
  ) {
    return false;
  }
  const body = response.json as {
    type?: unknown;
    error?: { type?: unknown; message?: unknown };
  };
  return (
    body.type === "error" &&
    body.error?.type === "api_error" &&
    typeof body.error.message === "string" &&
    INFERENCE_WARMING_MESSAGES.has(body.error.message)
  );
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
 * `providerOverrideKeys` in packages/cloud/scripts/admin/sync-api-dev-vars.ts).
 */
export function cerebrasConfigured(): boolean {
  return Boolean(process.env.CEREBRAS_API_KEY?.trim());
}
