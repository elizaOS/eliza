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
 * upstream response body straight to the client while a push-based meter
 * observes the same chunks in-line (no `tee()` — a second branch would let a
 * slow client accumulate an unbounded queue, #20032).
 *
 * This module owns the pieces that are independent of the route:
 *   - the `INFERENCE_PASSTHROUGH_STREAMING` flag (default OFF — same
 *     soak-then-cutover discipline as the #9899 INFERENCE_* flags; flag off is
 *     byte-identical to today),
 *   - the stream meter: an incremental SSE observer that extracts the
 *     terminal `stream_options.include_usage` usage frame plus the delivered
 *     text, which the route feeds into the EXISTING billing settle chain
 *     (billUsage → settleReservation → analytics → audit),
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
 * Stream milestones observed on the metered branch (#16079). `null` means the
 * boundary was never observed (no such frame arrived, or the read failed
 * first) — absence is reported as absence, never as zero.
 */
export interface PassthroughStreamMilestones {
  /**
   * First non-empty SSE `data:` event, timed at receipt. Malformed payloads
   * and `[DONE]` count: the upstream verifiably produced an event even when
   * its payload cannot be parsed (#20032), so time-to-first-event stays
   * truthful for degenerate streams.
   */
  firstEventMs: number | null;
  /** First delta carrying reasoning (`reasoning`, `reasoning_content`, or `thinking`). */
  firstReasoningMs: number | null;
  /** First delta carrying visible `content` text. */
  firstContentMs: number | null;
  /**
   * Protocol completion: the provider's `data: [DONE]` marker, timed when it
   * was parsed. A clean EOF WITHOUT `[DONE]` is a truncated stream and leaves
   * this null (#20032) — a cut connection must never look like a completed
   * one.
   */
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

/** Injectable timing options shared by the meter and the reader wrapper. */
export interface PassthroughMeterOptions {
  /** Monotonic origin the milestone timestamps are measured from. */
  startedAt?: number;
  /** Injectable clock; defaults to a receiver-safe `performance.now()` call. */
  now?: () => number;
}

/**
 * Push-based incremental SSE meter for the pass-through pipe. The route feeds
 * it the exact chunks it forwards to the client (single upstream reader, no
 * `tee()`), so upstream pulling stays bounded by the client's own
 * backpressure and the meter can never accumulate an unbounded queue behind a
 * slow consumer (#20032 defect 4).
 *
 * `observe` is synchronous and never throws — this is the billing meter, and
 * a parsing defect must not corrupt the byte pipe (error-policy: J7, recorded
 * as `readError`). `finish` (clean upstream EOF) and `fail` (read error /
 * client abort) are terminal and idempotent; both return the tail snapshot
 * the settle chain consumes.
 */
export interface PassthroughStreamMeter {
  observe(chunk: Uint8Array): void;
  finish(): PassthroughStreamTail;
  fail(error: unknown): PassthroughStreamTail;
}

/**
 * Build a stream meter. Milestone timestamps (#16079) are taken when a frame
 * is observed, elapsed from `startedAt` against the injected `now` clock
 * (tests pin both; the route pins `startedAt` to the provider fetch
 * dispatch). The default clock closes over `performance` — never the unbound
 * `performance.now` reference, which throws on receiver-enforcing runtimes
 * (#20032 defect 1).
 */
export function createPassthroughStreamMeter(
  options: PassthroughMeterOptions = {},
): PassthroughStreamMeter {
  const now = options.now ?? (() => performance.now());
  const startedAt = options.startedAt ?? now();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
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
    // First-event is a receipt-time boundary (#20032 defect 2): the upstream
    // verifiably emitted an event, so it counts even when the payload is
    // malformed or is the bare `[DONE]` terminal.
    tail.milestones.firstEventMs ??= roundedElapsed(now, startedAt);
    if (payload === "[DONE]") {
      tail.sawDone = true;
      // [DONE] IS the provider's completion marker (#16079): record it now
      // rather than at EOF, so a provider that delays the connection close
      // after [DONE] cannot skew the boundary. Gated on !sawErrorFrame: an
      // error frame already parsed means the provider reported failure —
      // [DONE] after it must not resurrect completion.
      if (!tail.sawErrorFrame) {
        tail.milestones.completionMs ??= roundedElapsed(now, startedAt);
      }
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
    if (record.error !== undefined && record.error !== null) {
      tail.sawErrorFrame = true;
      // An error frame parsed AFTER [DONE] revokes that completion (#16079):
      // the provider reported failure even though it had emitted its terminal
      // marker — both orderings (error→[DONE], [DONE]→error) must land on
      // "failed, no completion".
      tail.milestones.completionMs = null;
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

  const consume = (text: string) => {
    buffer += text;
    let newlineAt = buffer.indexOf("\n");
    while (newlineAt !== -1) {
      handleLine(buffer.slice(0, newlineAt));
      buffer = buffer.slice(newlineAt + 1);
      newlineAt = buffer.indexOf("\n");
    }
  };

  return {
    observe(chunk: Uint8Array): void {
      if (terminal) return;
      try {
        consume(decoder.decode(chunk, { stream: true }));
      } catch (error) {
        // error-policy:J7 metering must not corrupt the byte pipe — the route
        // observes the failure via readError and settles conservatively.
        tail.readError ??= error;
      }
    },
    finish(): PassthroughStreamTail {
      if (terminal) return tail;
      terminal = true;
      try {
        consume(decoder.decode());
        if (buffer) {
          handleLine(buffer);
          buffer = "";
        }
      } catch (error) {
        // error-policy:J7 see observe().
        tail.readError ??= error;
      }
      // A clean EOF does NOT fabricate completion: only [DONE] proves the
      // provider finished its protocol (#20032 defect 3). A truncated stream
      // (EOF without [DONE]) keeps completionMs null and sawDone false so
      // telemetry and settlement see it as incomplete.
      return tail;
    },
    fail(error: unknown): PassthroughStreamTail {
      if (!terminal) {
        terminal = true;
        tail.readError ??=
          error ?? new DOMException("The client stopped reading the stream", "AbortError");
      }
      return tail;
    },
  };
}

/**
 * Drain a whole SSE stream through the meter and report what it carried —
 * the pull-based wrapper for callers that own a dedicated branch (tests, any
 * future non-piped consumer). Never throws: a read failure (client abort,
 * upstream drop) is returned as `readError` with everything observed up to
 * that point intact, and the route settles from it exactly like the onAbort
 * path.
 */
export async function readPassthroughStreamTail(
  stream: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
  options: PassthroughMeterOptions = {},
): Promise<PassthroughStreamTail> {
  const meter = createPassthroughStreamMeter(options);
  const reader = stream.getReader();
  let abortError: unknown = null;
  const abortMeter = () => {
    abortError ??=
      abortSignal?.reason ??
      new DOMException("The client stopped reading the stream", "AbortError");
    // error-policy:J7 metering cancellation records failure for settlement.
    void reader.cancel(abortError).catch((error) => {
      abortError ??= error;
    });
  };
  if (abortSignal?.aborted) {
    abortMeter();
  } else {
    abortSignal?.addEventListener("abort", abortMeter, { once: true });
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      meter.observe(value);
    }
    if (abortError !== null) return meter.fail(abortError);
    return meter.finish();
  } catch (error) {
    // error-policy:J7 metering must not kill the settle chain — the route
    // observes the failure via readError and settles the delivered portion.
    return meter.fail(abortError ?? error);
  } finally {
    abortSignal?.removeEventListener("abort", abortMeter);
    reader.releaseLock();
  }
}
