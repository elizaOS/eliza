/**
 * Streaming adapter for `LlamaChatSession.prompt()` -> `TextStreamResult`.
 *
 * ## Why this module exists
 *
 * `node-llama-cpp` exposes a **push-based** token stream: you pass an
 * `onTextChunk(text)` callback to `prompt()` / `promptWithMeta()` and it
 * fires once per detokenized chunk. The elizaOS runtime, however, drains a
 * **pull-based** `TextStreamResult` (see `packages/core/src/runtime.ts`
 * `isTextStreamResult` shape: `{ textStream, text, usage, finishReason }`).
 *
 * To bridge the two we run `prompt()` and a queue-backed async generator
 * concurrently:
 *
 *   - `onTextChunk` enqueues each delta and resolves a pending pull.
 *   - The async generator yields whatever is in the queue, awaits the next
 *     push if drained, and exits when the prompt promise settles.
 *
 * The promises returned in the result (`text`, `usage`, `finishReason`) are
 * fulfilled when the underlying `prompt()` finishes, so callers that only
 * read those fields still get a useful answer.
 *
 * ## Contract parity with plugin-ollama
 *
 * Plugin-ollama returns `TextStreamResult` from `streamText()` (see
 * `plugins/plugin-ollama/models/text.ts`, `buildOllamaStreamTextResult`).
 * The runtime's `isTextStreamResult` check at
 * `packages/core/src/runtime.ts:417` requires exactly four fields:
 * `textStream` (`AsyncIterable<string>`), `text` (`Promise<string>`),
 * `usage` (`Promise<TokenUsage | undefined>`), and `finishReason`
 * (`Promise<string | undefined>`). This adapter mirrors that shape so the
 * runtime cannot tell local from cloud (other than the latency profile).
 *
 * The `params.onStreamChunk` SSE wiring is fulfilled at the runtime layer
 * (`runtime.ts:4659` drains `textStream` and invokes the param's chunk
 * callback). We deliberately do **not** also call `params.onStreamChunk`
 * directly inside the handler — that would double-deliver each chunk.
 */

import type { TextStreamResult, TokenUsage } from "@elizaos/core";
import type { LlamaChatSession } from "node-llama-cpp";

type LlamaPromptOptions = Parameters<LlamaChatSession["prompt"]>[1];

export interface StreamLlamaPromptArgs {
  session: LlamaChatSession;
  prompt: string;
  /** Forwarded verbatim to `LlamaChatSession.prompt()`. */
  options: Omit<LlamaPromptOptions, "onTextChunk" | "onToken">;
  /**
   * Optional pre-stream chunk hook. Used by tests; production callers should
   * rely on the runtime draining `textStream` rather than wiring this. The
   * runtime forwards `params.onStreamChunk` itself once it sees the
   * `TextStreamResult` shape come back.
   */
  onChunk?: (delta: string) => void;
  /**
   * Token-usage estimator for the case where the underlying engine doesn't
   * report usage (`node-llama-cpp` doesn't surface a `usage` field on
   * `prompt()`). Same fallback strategy as plugin-ollama's
   * `estimateUsage(promptForUsageEstimate, fullText)`.
   */
  estimateUsage: (prompt: string, fullText: string) => TokenUsage;
  /**
   * Invoked once after the underlying `prompt()` settles (success or
   * failure). Lets the caller emit `MODEL_USED` once with the final usage,
   * mirroring plugin-ollama's `usagePromise.then(emitModelUsed)` pattern.
   */
  onComplete?: (info: { fullText: string; usage: TokenUsage }) => void;
  /**
   * Strip-after-completion hook. Local models occasionally emit `<think>`
   * scaffolding; the non-streaming path runs `stripThinkTags` on the final
   * text. We expose the hook here so the resolved `text` Promise matches
   * the non-streaming return value byte-for-byte.
   */
  postProcess?: (raw: string) => string;
}

export function streamLlamaPrompt(args: StreamLlamaPromptArgs): TextStreamResult {
  const queue: string[] = [];
  let pendingResolve: ((value: IteratorResult<string>) => void) | null = null;
  let promptError: unknown = null;
  let promptDone = false;
  let rawAccumulated = "";

  const drain = (): void => {
    if (!pendingResolve) return;
    if (queue.length > 0) {
      const next = queue.shift() as string;
      const resolver = pendingResolve;
      pendingResolve = null;
      resolver({ value: next, done: false });
      return;
    }
    if (promptDone) {
      const resolver = pendingResolve;
      pendingResolve = null;
      resolver({ value: undefined, done: true });
    }
  };

  const promptPromise: Promise<string> = (async () => {
    try {
      const result = await args.session.prompt(args.prompt, {
        ...args.options,
        onTextChunk: (chunk: string) => {
          rawAccumulated += chunk;
          // Tests pre-attach an onChunk to assert per-token delivery without
          // having to drain the async iterable manually.
          args.onChunk?.(chunk);
          queue.push(chunk);
          drain();
        },
      });
      return result;
    } finally {
      promptDone = true;
      drain();
    }
  })();

  // Failures propagate to consumers via the textStream generator. The
  // caught-here rejection avoids `UnhandledPromiseRejection` if a caller
  // only reads `usage` / `finishReason`.
  promptPromise.catch((err) => {
    promptError = err;
  });

  const textStream: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next(): Promise<IteratorResult<string>> {
          if (promptError) {
            return Promise.reject(promptError);
          }
          if (queue.length > 0) {
            const next = queue.shift() as string;
            return Promise.resolve({ value: next, done: false });
          }
          if (promptDone) {
            return Promise.resolve({
              value: undefined as unknown as string,
              done: true,
            });
          }
          return new Promise<IteratorResult<string>>((resolve) => {
            pendingResolve = resolve;
          });
        },
      };
    },
  };

  const fullTextPromise: Promise<string> = promptPromise.then((finalText) => {
    // Prefer the prompt return value; fall back to the accumulator if the
    // engine ever returns an empty string but emitted chunks (defensive).
    const raw = finalText && finalText.length > 0 ? finalText : rawAccumulated;
    return args.postProcess ? args.postProcess(raw) : raw;
  });

  const usagePromise: Promise<TokenuageOrUndefined> = fullTextPromise
    .then((fullText) => {
      const usage = args.estimateUsage(args.prompt, fullText);
      args.onComplete?.({ fullText, usage });
      return usage as TokenUsage | undefined;
    })
    .catch(() => undefined);

  // node-llama-cpp's `prompt()` doesn't expose a discrete finish reason
  // on the simple-prompt API. `promptWithMeta()` does, but the streaming
  // surface here is the simple form (matches the non-tool/non-schema
  // branch of `LocalAIManager.generateText`). Resolve to "stop" on
  // success, undefined on error — consistent with what callers expect
  // and with plugin-ollama's `Promise.resolve(streamResult.finishReason)`
  // best-effort posture.
  const finishReasonPromise: Promise<string | undefined> = promptPromise
    .then(() => "stop" as string | undefined)
    .catch(() => undefined);

  return {
    textStream,
    text: fullTextPromise,
    usage: usagePromise,
    finishReason: finishReasonPromise,
  };
}

// Local alias to keep the return type union readable above. TypeScript
// doesn't widen union promise types nicely otherwise.
type TokenuageOrUndefined = TokenUsage | undefined;
