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
 * This module owns the pieces that are independent of the route:
 *   - the `INFERENCE_PASSTHROUGH_STREAMING` flag (default OFF — same
 *     soak-then-cutover discipline as the #9899 INFERENCE_* flags; flag off is
 *     byte-identical to today),
 *   - the background meter: an SSE reader for the teed branch that extracts
 *     the terminal `stream_options.include_usage` usage frame plus the
 *     delivered text, which the route feeds into the EXISTING billing settle
 *     chain (billUsage → settleReservation → analytics → audit),
 *   - stream milestone observation (#16079): the same reader records when the
 *     first SSE frame, the first reasoning delta, the first visible content
 *     delta, and stream completion were observed, so one correlated trace can
 *     assign provider-side latency instead of collapsing it into "gateway
 *     time". Milestones are measured at the meter branch against an injected
 *     monotonic origin (the route pins it to the provider fetch start); they
 *     bound when the upstream made each frame available, not when a specific
 *     client received it.
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
 * Sibling flag for the non-streaming embeddings pipe (#15512). Same soak
 * discipline and rollback shape as the streaming flag; embeddings are simpler
 * (single JSON response, no tee) so the two roll out independently.
 */
export function isPassthroughEmbeddingsEnabled(env: StringEnv = getCloudAwareEnv()): boolean {
  return (env.INFERENCE_PASSTHROUGH_EMBEDDINGS ?? "").trim() === "true";
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

/**
 * Stream milestones observed on the teed branch (#16079). `null` means the
 * boundary was never observed (no such frame arrived, or the read failed
 * first) — absence is reported as absence, never as zero.
 */
export interface PassthroughStreamMilestones {
  /** First non-empty `data:` frame of any kind (the first SSE event). */
  firstEventMs: number | null;
  /** First delta carrying reasoning (`reasoning`, `reasoning_content`, or `thinking`). */
  firstReasoningMs: number | null;
  /** First delta carrying visible `content` text. */
  firstContentMs: number | null;
  /** Reader observed stream termination (upstream close or `[DONE]`). */
  completionMs: number | null;
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
  /**
   * Frame milestones (#16079), elapsed from the supplied monotonic origin —
   * the route pins that origin to the provider fetch start so the milestones
   * measure upstream latency, not gateway queueing.
   */
  milestones: PassthroughStreamMilestones;
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

/**
 * Reasoning carriers seen in the wild: Cerebras/GLM use `reasoning` or
 * `reasoning_content`, Anthropic-style providers use `thinking`. Mirrors the
 * probe's `consumeOpenAiEvent` candidate list so gateway and probe agree on
 * what counts as the first reasoning frame.
 */
function hasReasoningDelta(delta: Record<string, unknown> | undefined): boolean {
  if (!delta) return false;
  // Non-empty only, mirroring the content milestone: providers emit empty
  // carrier strings on the first frame before any reasoning exists (#16079).
  return (
    (typeof delta.reasoning === "string" && delta.reasoning.length > 0) ||
    (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) ||
    (typeof delta.thinking === "string" && delta.thinking.length > 0)
  );
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

function roundedElapsed(now: () => number, origin: number): number {
  return Math.round((now() - origin) * 100) / 100;
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
 *
 * Milestone timestamps (#16079) are taken when a frame is PARSED, using
 * `startedAt` as the monotonic origin and the injectable `now` clock (tests
 * pin both). The tee delivers both branches at the reader's pace, so these
 * timestamps bound the upstream's frame availability; they are not proof of
 * exactly when the client branch delivered the same bytes.
 */
export async function readPassthroughStreamTail(
  stream: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
  options: {
    /** Monotonic origin the milestone timestamps are measured from. */
    startedAt?: number;
    /** Injectable clock; defaults to `performance.now`. */
    now?: () => number;
  } = {},
): Promise<PassthroughStreamTail> {
  const now = options.now ?? performance.now;
  const startedAt = options.startedAt ?? now();
  const decoder = new TextDecoder();
  const tail: PassthroughStreamTail = {
    usage: null,
    deliveredText: "",
    sawDone: false,
    sawErrorFrame: false,
    readError: null,
    milestones: {
      firstEventMs: null,
      firstReasoningMs: null,
      firstContentMs: null,
      completionMs: null,
    },
  };

  const handleLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const payload = line.slice("data:".length).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      tail.sawDone = true;
      // [DONE] IS the provider's completion marker (#16079): record it now
      // rather than at EOF, so a provider that delays the connection close
      // after [DONE] (or drops it) cannot skew or lose the boundary.
      tail.milestones.completionMs ??= roundedElapsed(now, startedAt);
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
      choices?: Array<{ delta?: { content?: unknown } & Record<string, unknown> }>;
      usage?: SseUsageRecord | null;
      error?: unknown;
    };
    tail.milestones.firstEventMs ??= roundedElapsed(now, startedAt);
    if (record.error !== undefined && record.error !== null) {
      tail.sawErrorFrame = true;
    }
    if (Array.isArray(record.choices)) {
      for (const choice of record.choices) {
        const delta = choice?.delta;
        if (!delta || typeof delta !== "object") continue;
        const content = delta.content;
        if (typeof content === "string" && content.length > 0) {
          tail.deliveredText += content;
          tail.milestones.firstContentMs ??= roundedElapsed(now, startedAt);
        }
        if (hasReasoningDelta(delta as Record<string, unknown>)) {
          tail.milestones.firstReasoningMs ??= roundedElapsed(now, startedAt);
        }
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
  const abortMeter = () => {
    tail.readError ??=
      abortSignal?.reason ??
      new DOMException("The client stopped reading the stream", "AbortError");
    // error-policy:J7 metering cancellation records failure for settlement.
    void reader.cancel(tail.readError).catch((error) => {
      tail.readError ??= error;
    });
  };
  if (abortSignal?.aborted) {
    abortMeter();
  } else {
    abortSignal?.addEventListener("abort", abortMeter, { once: true });
  }
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
    // Normal termination (upstream close, with or without [DONE]) still counts
    // as observed completion; abort/error paths fall through with the
    // milestone left null so they cannot masquerade as a completed stream.
    // `??=` — NOT assignment — so a completion already recorded at [DONE]
    // parse time keeps the [DONE] boundary even when the provider delays the
    // connection close after it (#16079). An in-stream SSE error frame is NOT
    // completion: the provider reported failure mid-stream and the stream must
    // not be recorded as if it ran to a healthy end.
    if (tail.readError === null && !tail.sawErrorFrame) {
      tail.milestones.completionMs ??= roundedElapsed(now, startedAt);
    }
  } catch (error) {
    // error-policy:J7 metering must not kill the settle chain — the route
    // observes the failure via readError and settles the delivered portion.
    tail.readError = error;
  } finally {
    abortSignal?.removeEventListener("abort", abortMeter);
    reader.releaseLock();
  }
  return tail;
}
