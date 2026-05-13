/**
 * Uniform inference dispatcher.
 *
 * Both backends — the out-of-process `llama-server` child process
 * (`dflash-server.ts`, desktop / GPU) and the in-process bun:ffi
 * streaming runner (`ffi-streaming-runner.ts`, mobile + opt-in desktop)
 * — produce token-grained generation output, but their callback shapes
 * differ. The HTTP path emits SSE chunks via `onTextChunk` plus
 * `onVerifierEvent` synthesized from streaming deltas (or true
 * accept/reject events on a native-DFlash build). The FFI path emits a
 * `LlmStreamStep` for each pump iteration.
 *
 * This module presents one async-iterable surface — `dispatchGenerate()`
 * — that wraps either backend and yields the same `InferenceStreamEvent`
 * shape regardless of which one is in use. Callers that don't care which
 * backend is live (the streaming API in the dashboard, the voice
 * scheduler, the embedding chat completion bridge) target the dispatcher
 * instead of either backend directly.
 *
 * The dispatcher does NOT decide which backend to use — that is
 * `selectBackend()` (`backend-selector.ts`), driven by
 * `inferenceRuntimeMode()` (`runtime-target.ts`). The dispatcher takes a
 * resolved backend handle and a normalised request and unifies the
 * output stream.
 *
 * Event shape (deliberately aligned with the DFlash native protocol so
 * consumers that already parse the wire format keep working):
 *
 *   - `text`            — every text chunk; one per non-empty step / SSE chunk
 *   - `accept`          — verifier accept event (matches
 *                          DflashAcceptEvent in dflash-event-schema.ts)
 *   - `reject`          — verifier reject event (only on backends that
 *                          surface true rejects; the HTTP path with
 *                          legacy synthesis never emits these)
 *   - `done`            — terminal event; carries totals
 *   - `error`           — terminal error; the iterator throws after
 *                          emitting it so callers can opt to inspect
 *                          the structured form before catching
 *
 * The event taxonomy is intentionally a subset of
 * `dflash-event-schema.ts` plus generic `text` / `done` framing — we do
 * not redefine the wire-format types here (the other agent owns the
 * schema). Callers that need the full DFlash event set bridge through
 * the `onDflashEvent` escape hatch.
 */

import type { LocalInferenceBackend as SelectorBackend } from "./backend-selector";
import type { DflashStreamEvent } from "./dflash-event-schema";
import type {
  FfiStreamingGenerateArgs,
  FfiStreamingRunner,
} from "./ffi-streaming-runner";
import type { VerifierStreamEvent } from "./voice/types";

/**
 * One event from a unified generation stream. Both backends produce the
 * same shape; consumers do not need to know which one is live.
 */
export type InferenceStreamEvent =
  | { kind: "text"; text: string }
  | {
      kind: "accept";
      /** Token ids the verifier just committed. */
      tokens: number[];
      /** Detokenized text for `tokens` (may be empty if backend can't reverse). */
      text: string;
    }
  | {
      kind: "reject";
      /** Inclusive range in target output order, like DflashRejectEvent. */
      rejectRange: readonly [number, number];
      /** Token id the verifier substituted for the start of the rejected span. */
      correctedToken: number;
    }
  | {
      kind: "done";
      /** Aggregated text for the whole turn. */
      text: string;
      drafted: number;
      accepted: number;
      firstTokenMs: number | null;
    };

/**
 * Normalised input for `dispatchGenerate`. Each backend implementation
 * receives a translated subset (the HTTP path takes a prompt string; the
 * FFI path takes pre-tokenized ids), so callers always provide both —
 * the dispatcher routes accordingly.
 *
 * Keeping the union resolved at the call site (rather than asking the
 * dispatcher to tokenize) preserves the existing tokenizer ownership:
 * the HTTP path delegates tokenization to llama-server; the FFI path
 * delegates it to the voice-lifecycle tokenizer that already lives on
 * the FFI handle.
 */
export interface DispatchGenerateInput {
  backend: SelectorBackend;
  /** HTTP-backend args — passed through to `DflashLlamaServer.generateWithUsage`. */
  http?: {
    /** Resolved server adapter. The dispatcher does not own this. */
    runner: HttpStreamingAdapter;
    /** Prompt text — tokenized by llama-server. */
    prompt: string;
    /** Per-turn knobs. */
    maxTokens: number;
    temperature: number;
    topP: number;
    cacheKey?: string;
    slotId?: number;
    signal?: AbortSignal;
    /** Optional pass-through for native DFlash events the runner saw. */
    onDflashEvent?: (event: DflashStreamEvent) => void | Promise<void>;
  };
  /** FFI-backend args — handed straight to `FfiStreamingRunner.generateStream`. */
  ffi?: {
    runner: FfiStreamingRunner;
    args: FfiStreamingGenerateArgs;
  };
}

/**
 * Minimum surface the dispatcher needs from the HTTP server runner. The
 * full `DflashLlamaServer` class lives in `dflash-server.ts` and exposes
 * `generateWithUsage` plus other methods; the dispatcher only uses the
 * streaming call, so the boundary is narrow and easy to mock in tests.
 */
export interface HttpStreamingAdapter {
  generateWithUsage(args: {
    prompt: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    cacheKey?: string;
    slotId?: number;
    signal?: AbortSignal;
    onTextChunk?: (chunk: string) => void | Promise<void>;
    onVerifierEvent?: (event: VerifierStreamEvent) => void | Promise<void>;
    onDflashEvent?: (event: DflashStreamEvent) => void | Promise<void>;
  }): Promise<{
    text: string;
    slotId: number;
    firstTokenMs: number | null;
    // Other fields (usage, dflashStats) are intentionally ignored — they
    // are surfaced through the parallel metrics path, not the event stream.
  }>;
}

/**
 * Run one generation against the requested backend and yield unified
 * events. Throws if the input describes a backend it has no adapter for
 * (i.e. caller forgot to populate `http` or `ffi`).
 *
 * Single-flight is the responsibility of each backend implementation;
 * the dispatcher does not add another lock layer on top.
 *
 * Cancellation: the caller's `AbortSignal` propagates into the
 * underlying backend via the existing channels (HTTP `fetch` signal /
 * `FfiStreamingRunner` abort listener). Aborts surface as a thrown
 * error from the iterator, not as a synthesized `error` event — that
 * matches both `dflash-server.ts` and `ffi-streaming-runner.ts`.
 */
export async function* dispatchGenerate(
  input: DispatchGenerateInput,
): AsyncIterable<InferenceStreamEvent> {
  if (input.backend === "ffi-streaming") {
    if (!input.ffi) {
      throw new Error(
        "[runtime-dispatcher] backend=ffi-streaming but no ffi.runner / ffi.args supplied",
      );
    }
    yield* dispatchFfi(input.ffi);
    return;
  }
  if (input.backend === "http-server") {
    if (!input.http) {
      throw new Error(
        "[runtime-dispatcher] backend=http-server but no http.runner supplied",
      );
    }
    yield* dispatchHttp(input.http);
    return;
  }
  // `selectBackend()`'s return type is closed; the exhaustiveness check
  // is a belt-and-braces guard so a future backend addition doesn't
  // silently fall through here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _exhaustive: never = input.backend;
  throw new Error(
    `[runtime-dispatcher] unknown backend: ${String(input.backend)}`,
  );
}

async function* dispatchFfi(
  ffi: NonNullable<DispatchGenerateInput["ffi"]>,
): AsyncIterable<InferenceStreamEvent> {
  const aggregated: string[] = [];
  let totalDrafted = 0;
  let totalAccepted = 0;
  let firstTokenMs: number | null = null;
  const started = performance.now();

  for await (const step of ffi.runner.generateStream(ffi.args)) {
    if (step.text.length > 0) {
      if (firstTokenMs === null) {
        firstTokenMs = performance.now() - started;
      }
      aggregated.push(step.text);
      yield { kind: "text", text: step.text };
      if (step.tokens.length > 0) {
        // The FFI step batches accepted tokens — surface that as one
        // accept event so consumers see a matching shape to the HTTP
        // path's per-chunk synthesized accepts.
        yield {
          kind: "accept",
          tokens: [...step.tokens],
          text: step.text,
        };
      }
    }
    totalDrafted += step.drafterDrafted;
    totalAccepted += step.drafterAccepted;
    if (step.done) {
      yield {
        kind: "done",
        text: aggregated.join(""),
        drafted: totalDrafted,
        accepted: totalAccepted,
        firstTokenMs,
      };
      return;
    }
  }

  // FFI runner finished without a done step — synthesize one so the
  // consumer's iterator terminates cleanly. This shouldn't happen on a
  // healthy backend but the guard keeps the contract simple.
  yield {
    kind: "done",
    text: aggregated.join(""),
    drafted: totalDrafted,
    accepted: totalAccepted,
    firstTokenMs,
  };
}

async function* dispatchHttp(
  http: NonNullable<DispatchGenerateInput["http"]>,
): AsyncIterable<InferenceStreamEvent> {
  // Bridge the callback-based HTTP runner into a pull-based async
  // iterator. The pattern mirrors `FfiStreamingRunner.generateStream` —
  // a queue + resume hook so the iterator wakes on each callback.
  const queue: InferenceStreamEvent[] = [];
  let resume: (() => void) | null = null;
  let finished = false;
  let failure: Error | null = null;
  const wake = () => {
    const r = resume;
    resume = null;
    if (r) r();
  };

  const aggregated: string[] = [];
  let totalDrafted = 0;
  let totalAccepted = 0;

  const run = http.runner
    .generateWithUsage({
      prompt: http.prompt,
      maxTokens: http.maxTokens,
      temperature: http.temperature,
      topP: http.topP,
      cacheKey: http.cacheKey,
      slotId: http.slotId,
      signal: http.signal,
      onTextChunk: (chunk) => {
        if (chunk.length === 0) return;
        aggregated.push(chunk);
        queue.push({ kind: "text", text: chunk });
        wake();
      },
      onVerifierEvent: (event) => {
        if (event.kind === "accept") {
          // `TextToken.id` is optional — producers that only have surface
          // text (e.g. the whisper.cpp interim adapter) skip it. Filter
          // those out so the unified `accept` event carries only ids the
          // downstream consumer can use.
          const tokens = event.tokens
            .map((t) => t.id)
            .filter((id): id is number => typeof id === "number");
          const text = event.tokens.map((t) => t.text).join("");
          totalAccepted += event.tokens.length;
          totalDrafted += event.tokens.length;
          queue.push({ kind: "accept", tokens, text });
          wake();
        }
      },
      onDflashEvent: http.onDflashEvent
        ? async (event) => {
            await http.onDflashEvent?.(event);
            if (event.kind === "reject") {
              queue.push({
                kind: "reject",
                rejectRange: event.rejectRange,
                correctedToken: event.correctedToken,
              });
              wake();
            } else if (event.kind === "accept") {
              // Native accept events override the synthesized ones from
              // `onVerifierEvent`. We don't try to dedupe; the native
              // protocol disables the synthesis upstream (it sets
              // `capabilities.dflashNativeEvents`), so the SSE path
              // shouldn't emit both for the same drafter batch.
              queue.push({
                kind: "accept",
                tokens: [...event.accepted],
                text: "",
              });
              wake();
            }
          }
        : undefined,
    })
    .then(
      (result) => {
        queue.push({
          kind: "done",
          text: result.text,
          drafted: totalDrafted,
          accepted: totalAccepted,
          firstTokenMs: result.firstTokenMs,
        });
      },
      (err) => {
        failure = err instanceof Error ? err : new Error(String(err));
      },
    )
    .finally(() => {
      finished = true;
      wake();
    });

  try {
    while (true) {
      if (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) continue;
        yield next;
        if (next.kind === "done") return;
        continue;
      }
      if (failure) throw failure;
      if (finished) return;
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
    }
  } finally {
    await run;
  }
}
