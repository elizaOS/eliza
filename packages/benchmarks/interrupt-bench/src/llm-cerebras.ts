/**
 * Cerebras-backed LLM client for InterruptBench.
 *
 * Calls `https://api.cerebras.ai/v1/chat/completions` with an OpenAI-compatible
 * payload, model `gpt-oss-120b`, and a strict JSON response_format derived from
 * the registry-composed Stage-1 schema. Parses the result into the same
 * `ResponseHandlerResult` shape the scripted provider returns.
 *
 * The `CEREBRAS_API_KEY` env var is required. The runner does NOT fall back to
 * scripted if cerebras mode fails — surface the error.
 */

import type { JSONSchema, ResponseHandlerResult } from "@elizaos/core";

const _CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
const DEFAULT_MODEL = "gpt-oss-120b";

interface CerebrasMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CerebrasCallInput {
  systemPrompt: string;
  messages: CerebrasMessage[];
  schema: JSONSchema;
  model?: string;
  /** Hard timeout for the call (real ms). */
  timeoutMs?: number;
}

interface CerebrasCallResult {
  parsed: ResponseHandlerResult;
  /** Wall-clock latency for the round trip, ms. */
  latencyMs: number;
  /** Raw response payload, useful for debugging. */
  raw: unknown;
}

interface CerebrasCallError extends Error {
  status?: number;
  body?: string;
}

function readEnv(): { apiKey: string; baseUrl: string } {
  const apiKey = process.env.CEREBRAS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "CEREBRAS_API_KEY not set. Add it to your environment or .env file at the repo root.",
    );
  }
  const baseUrl =
    process.env.CEREBRAS_BASE_URL?.trim() || "https://api.cerebras.ai/v1";
  return { apiKey, baseUrl };
}

/**
 * Run one Cerebras chat-completions call with strict JSON output. Throws on
 * non-2xx or invalid JSON.
 */
export async function callCerebras(
  input: CerebrasCallInput,
): Promise<CerebrasCallResult> {
  const { apiKey, baseUrl } = readEnv();
  const url = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const body = {
    model: input.model ?? DEFAULT_MODEL,
    messages: [
      { role: "system" as const, content: input.systemPrompt },
      ...input.messages,
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "interrupt_bench_response",
        strict: true,
        schema: input.schema,
      },
    },
    temperature: 0,
    max_tokens: 2048,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const errBody = await res.text();
    const err = new Error(
      `Cerebras call failed: ${res.status} ${res.statusText} :: ${errBody.slice(0, 500)}`,
    ) as CerebrasCallError;
    err.status = res.status;
    err.body = errBody;
    throw err;
  }

  const raw = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = raw.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(
      `Cerebras returned no message.content. Raw: ${JSON.stringify(raw).slice(0, 500)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (parseErr) {
    throw new Error(
      `Cerebras returned non-JSON content: ${parseErr instanceof Error ? parseErr.message : String(parseErr)} :: ${content.slice(0, 500)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `Cerebras JSON was not an object: ${content.slice(0, 200)}`,
    );
  }
  return {
    parsed: parsed as ResponseHandlerResult,
    latencyMs,
    raw,
  };
}

/**
 * Lightweight check: returns true if CEREBRAS_API_KEY is set.
 */
export function isCerebrasConfigured(): boolean {
  return !!process.env.CEREBRAS_API_KEY?.trim();
}
