/**
 * Pass-through streaming fast path for the inference gateway (#15428).
 *
 * The default streaming route decodes the provider's SSE bytes through the AI
 * SDK (`streamText` → per-part processing → OpenAI-compat re-encode), which
 * measures at ~1.5s TTFB / ~5s total against ~0.17s / ~0.6s for the identical
 * call made directly to the upstream — the overhead is the Worker-side
 * decode/re-encode pipeline, not the provider. For requests that need NO
 * transformation (plain streaming chat against an OpenAI-compatible upstream,
 * no tools / response_format / web search), the route can instead pipe the
 * upstream response body straight to the client and meter a teed copy in the
 * background.
 *
 * This module owns the two pieces that are independent of the route:
 *   - the `INFERENCE_PASSTHROUGH_STREAMING` flag (default OFF — same
 *     soak-then-cutover discipline as the #9899 INFERENCE_* flags; flag off is
 *     byte-identical to today),
 *   - the background meter: an SSE reader for the teed branch that extracts
 *     the terminal `stream_options.include_usage` usage frame plus the
 *     delivered text, which the route feeds into the EXISTING billing settle
 *     chain (billUsage → settleReservation → analytics → audit).
 *
 * The qualification predicate and the upstream fetch/tee orchestration live in
 * the chat-completions route (they depend on route-local billing helpers); the
 * upstream resolution lives in providers/language-model.ts (provider
 * knowledge).
 */

import { getCloudAwareEnv } from "../runtime/cloud-bindings";

type StringEnv = Record<string, string | undefined>;

/**
 * Fast-path flag. Default OFF; "true" enables the pass-through pipe for
 * qualifying streaming requests. Rollback is flipping it off — the default
 * streamText path is untouched either way.
 */
export function isPassthroughStreamingEnabled(env: StringEnv = getCloudAwareEnv()): boolean {
  return (env.INFERENCE_PASSTHROUGH_STREAMING ?? "").trim() === "true";
}

/**
 * Token usage extracted from the upstream's terminal usage frame, in the field
 * names `billUsage` normalizes — so the settle chain bills exactly what the
 * provider reported, same as the SDK path's `onFinish` usage.
 */
export interface PassthroughUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
}

/** What the background meter observed on the teed upstream branch. */
export interface PassthroughStreamTail {
  /** Last usage frame seen (OpenAI contract: the terminal frame before [DONE]). */
  usage: PassthroughUsage | null;
  /** Concatenated `choices[*].delta.content` — the text actually delivered. */
  deliveredText: string;
  /** `data: [DONE]` was observed — the stream terminated normally. */
  sawDone: boolean;
  /** An OpenAI-shaped in-stream `error` frame was observed. */
  sawErrorFrame: boolean;
  /** Read failure (client abort / upstream drop); partial fields above remain valid. */
  readError: unknown;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface SseUsageRecord {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
}

function extractUsage(record: SseUsageRecord): PassthroughUsage | null {
  const inputTokens = asFiniteNumber(record.prompt_tokens);
  const outputTokens = asFiniteNumber(record.completion_tokens);
  const totalTokens = asFiniteNumber(record.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return null;
  }
  const cacheReadInputTokens = asFiniteNumber(record.prompt_tokens_details?.cached_tokens);
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
  };
}

/**
 * Drain one tee branch of the upstream SSE response and report what it
 * carried. This is the billing meter, so it must never throw: a read failure
 * (client abort propagated to the upstream fetch, upstream drop) is returned
 * as `readError` with everything observed up to that point intact, and the
 * route settles from it exactly like today's onAbort path. Malformed frames
 * are skipped — the meter reports only what the provider verifiably sent,
 * never fabricated tokens (error-policy: J3 — an unparseable frame yields "no
 * data", not fake-valid data).
 */
export async function readPassthroughStreamTail(
  stream: ReadableStream<Uint8Array>,
): Promise<PassthroughStreamTail> {
  const decoder = new TextDecoder();
  const tail: PassthroughStreamTail = {
    usage: null,
    deliveredText: "",
    sawDone: false,
    sawErrorFrame: false,
    readError: null,
  };

  const handleLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const payload = line.slice("data:".length).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      tail.sawDone = true;
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(payload);
    } catch {
      // error-policy:J3 untrusted upstream frame — skip; the meter never invents data.
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const record = frame as {
      choices?: Array<{ delta?: { content?: unknown } }>;
      usage?: SseUsageRecord | null;
      error?: unknown;
    };
    if (record.error !== undefined && record.error !== null) {
      tail.sawErrorFrame = true;
    }
    if (Array.isArray(record.choices)) {
      for (const choice of record.choices) {
        const content = choice?.delta?.content;
        if (typeof content === "string") tail.deliveredText += content;
      }
    }
    if (record.usage && typeof record.usage === "object") {
      // Last frame wins: per the OpenAI contract the real usage arrives on the
      // terminal frame; earlier frames carry `usage: null` and are skipped by
      // extractUsage returning null only when no token field is present.
      const usage = extractUsage(record.usage);
      if (usage) tail.usage = usage;
    }
  };

  const reader = stream.getReader();
  try {
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt !== -1) {
        handleLine(buffer.slice(0, newlineAt));
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);
  } catch (error) {
    // error-policy:J7 metering must not kill the settle chain — the route
    // observes the failure via readError and settles the delivered portion.
    tail.readError = error;
  } finally {
    reader.releaseLock();
  }
  return tail;
}
