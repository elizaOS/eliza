/**
 * Live smoke test for a Vast OpenAI-compatible endpoint.
 *
 * This is intentionally outside the unit suite: it requires real endpoint
 * credentials and should be run after upsert/provision but before wiring a
 * model into production traffic.
 */

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
}

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value && value.trim().length > 0) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function postChat(baseUrl: string, apiKey: string, model: string): Promise<ChatResponse> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: eliza-vast-smoke-ok" }],
      max_tokens: 16,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(Number(readEnv("VAST_SMOKE_TIMEOUT_MS", "180000"))),
  });
  const elapsedMs = Math.round(performance.now() - started);
  const text = await response.text();
  let body: ChatResponse;
  try {
    body = JSON.parse(text) as ChatResponse;
  } catch {
    throw new Error(
      `Vast smoke returned non-JSON status=${response.status}: ${text.slice(0, 500)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Vast smoke failed status=${response.status}: ${body.error?.message ?? text}`);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        elapsedMs,
        id: body.id,
        model: body.model,
        finishReason: body.choices?.[0]?.finish_reason,
        content: body.choices?.[0]?.message?.content,
        usage: body.usage,
      },
      null,
      2,
    ),
  );
  return body;
}

export async function main(): Promise<void> {
  const apiKey = readEnv("VAST_API_KEY");
  const baseUrl = trimTrailingSlash(readEnv("VAST_BASE_URL"));
  const model = readEnv("VAST_MODEL", "eliza-1-27b");
  const body = await postChat(baseUrl, apiKey, model);
  const content = body.choices?.[0]?.message?.content ?? "";
  if (!content.toLowerCase().includes("eliza-vast-smoke-ok")) {
    throw new Error(`Vast smoke response did not contain expected marker: ${content}`);
  }
}

if (import.meta.main) {
  main().catch((err: Error) => {
    console.error(`[vast:smoke] failed: ${err.message}`);
    process.exit(1);
  });
}
