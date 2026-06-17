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

/** Colon-free Ollama alias (created via `ollama cp llama3.2:3b elizatest`). */
export const REAL_LLM_MODEL = "openai/elizatest";

/**
 * Whether a real local LLM (Ollama OpenAI-compatible endpoint) is reachable.
 * Real-LLM specs require this; when absent they skip loudly rather than larp a
 * fake completion. Locally (Ollama running) they run for real.
 */
export async function ollamaReachable(): Promise<boolean> {
  const base = process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:11434/v1";
  const root = base.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${root}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
