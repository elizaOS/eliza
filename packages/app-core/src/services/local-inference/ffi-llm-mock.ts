/**
 * Mock implementation of `FfiLlmStreamingAbi` for testing.
 *
 * This module provides a fully in-process fake of the C ABI surface
 * declared in `ffi-llm-streaming-abi.ts`. No native library is loaded,
 * no GGUF is read, and no real inference is performed. The mock is safe
 * to use in any test environment regardless of OS or hardware.
 *
 * Usage
 * ─────
 * ```ts
 * import { makeFfiLlmMock } from "./ffi-llm-mock";
 *
 * const mock = makeFfiLlmMock();
 * const caps  = detectMobileCapabilities(mock.ffi);
 * // caps.streamingLlm === true
 *
 * const handle = mock.ffi.eliza_inference_llm_stream_open("fake.gguf", 512, 4, 0)!;
 * mock.ffi.eliza_inference_llm_stream_prefill(handle, new Int32Array([1, 2, 3]), 0);
 *
 * const tokens: string[] = [];
 * await mock.ffi.eliza_inference_llm_stream_generate(handle, 32, 0.8, 0.95, (id, text, done) => {
 *   if (!done) tokens.push(text);
 * });
 * // tokens === ["Hello", " world", "!"]
 * ```
 *
 * Synthetic stream
 * ────────────────
 * `generate` fires the callback with three synthetic tokens:
 *   1. tokenId=1, tokenText="Hello", isDone=false  (after ~1 ms)
 *   2. tokenId=2, tokenText=" world", isDone=false (after ~1 ms)
 *   3. tokenId=3, tokenText="!",     isDone=true   (after ~1 ms)
 *
 * If `cancel` is called before the stream finishes, the mock observes the
 * cancellation flag between tokens and stops early. The last callback
 * invocation before cancellation will have `isDone=true` so callers
 * always receive a terminal event.
 *
 * State tracking
 * ──────────────
 * `makeFfiLlmMock()` returns a `MockState` alongside the ABI object. The
 * state object exposes internal counters that tests can assert on (e.g.
 * number of `open` / `close` / `cancel` calls, whether a handle is
 * considered open).
 */

import type {
  FfiDflashStreamingAbi,
  FfiLlmHandle,
  FfiLlmStreamingAbi,
  TokenCallback,
} from "./ffi-llm-streaming-abi";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A concrete mock handle — just a branded object wrapping an id. */
interface MockHandle extends FfiLlmHandle {
  readonly _brand: "FfiLlmHandle";
  readonly id: number;
}

function makeHandle(id: number): MockHandle {
  return Object.freeze({ _brand: "FfiLlmHandle" as const, id });
}

/**
 * Synthetic token sequence emitted by each generate call.
 *
 * The terminal token has `isDone: true` and an empty text so that callers
 * filtering on `!isDone` receive exactly three text tokens ("Hello",
 * " world", "!") matching the task specification.  The empty terminal
 * callback follows the same convention as the real C backend which fires
 * a zero-length step with the EOS flag set after the last real token.
 */
const SYNTHETIC_TOKENS: ReadonlyArray<
  { id: number; text: string; isDone: boolean }
> = [
  { id: 1, text: "Hello", isDone: false },
  { id: 2, text: " world", isDone: false },
  { id: 3, text: "!", isDone: false },
  { id: 0, text: "", isDone: true },
];

// ---------------------------------------------------------------------------
// Public mock state
// ---------------------------------------------------------------------------

/**
 * Observable state counters for the mock. Tests read these to verify
 * that the ABI layer is called in the right order.
 */
export interface MockState {
  /** Number of times `eliza_inference_llm_stream_open` was called. */
  openCount: number;
  /** Number of times `eliza_inference_llm_stream_prefill` was called. */
  prefillCount: number;
  /** Number of times `eliza_inference_llm_stream_generate` was called. */
  generateCount: number;
  /** Number of times `eliza_inference_llm_stream_cancel` was called. */
  cancelCount: number;
  /** Number of times `eliza_inference_llm_stream_close` was called. */
  closeCount: number;
  /**
   * Set of handle ids that have been opened but not yet closed.
   * Useful for detecting handle leaks in multi-generate tests.
   */
  openHandles: Set<number>;
  /**
   * True when cancel was called on the most recently opened handle
   * before the synthetic stream finished. Resets on the next `open`.
   */
  cancelledMidStream: boolean;
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

/**
 * Build a mock `FfiLlmStreamingAbi` (and a matching `FfiDflashStreamingAbi`
 * that delegates to the same synthetic stream) together with an observable
 * `MockState`.
 *
 * The returned `ffi` object satisfies both interface contracts so tests
 * can pass it to `detectMobileCapabilities()` and to `FfiStreamingRunner`
 * adapters without needing separate factories.
 */
export function makeFfiLlmMock(): {
  ffi: FfiLlmStreamingAbi & FfiDflashStreamingAbi & { llmStreamSupported(): boolean; ttsStreamSupported(): boolean };
  state: MockState;
} {
  let nextHandleId = 1;

  const state: MockState = {
    openCount: 0,
    prefillCount: 0,
    generateCount: 0,
    cancelCount: 0,
    closeCount: 0,
    openHandles: new Set(),
    cancelledMidStream: false,
  };

  // Per-handle cancellation flags. A Set of handle ids for which cancel
  // has been requested but the generate loop hasn't yet observed it.
  const cancelFlags = new Set<number>();

  // ---------------------------------------------------------------------------
  // Core helpers
  // ---------------------------------------------------------------------------

  function open(): FfiLlmHandle {
    const id = nextHandleId++;
    state.openCount++;
    state.openHandles.add(id);
    state.cancelledMidStream = false;
    return makeHandle(id);
  }

  function prefill(): number {
    state.prefillCount++;
    // Return a fixed prefill count that tests can assert on.
    return 128;
  }

  /**
   * Drive the synthetic token stream. Uses `setTimeout(..., 1)` per token
   * so callers that `await` the generate call see real async behaviour
   * without blocking for long.
   *
   * Returns a Promise that resolves after the final `isDone=true` callback
   * fires (or after an early cancel).
   */
  function generate(
    handle: FfiLlmHandle,
    _maxNewTokens: number,
    _temperature: number,
    _topP: number,
    tokenCallback: TokenCallback,
  ): Promise<number> {
    const h = handle as MockHandle;
    state.generateCount++;

    return new Promise<number>((resolve) => {
      let tokenIdx = 0;

      function emitNext() {
        // Check cancellation between tokens.
        if (cancelFlags.has(h.id)) {
          cancelFlags.delete(h.id);
          state.cancelledMidStream = true;
          // Emit terminal event so the consumer's iterator always
          // terminates cleanly even on cancel.
          tokenCallback(0, "", true);
          resolve(0);
          return;
        }

        if (tokenIdx >= SYNTHETIC_TOKENS.length) {
          resolve(0);
          return;
        }

        const token = SYNTHETIC_TOKENS[tokenIdx++]!;
        tokenCallback(token.id, token.text, token.isDone);

        if (token.isDone) {
          resolve(0);
        } else {
          setTimeout(emitNext, 1);
        }
      }

      // Schedule the first token after a 1 ms delay to ensure async
      // behaviour — callers that poll synchronously would see an empty
      // stream otherwise.
      setTimeout(emitNext, 1);
    });
  }

  function cancel(handle: FfiLlmHandle): void {
    const h = handle as MockHandle;
    state.cancelCount++;
    cancelFlags.add(h.id);
  }

  function close(handle: FfiLlmHandle): void {
    const h = handle as MockHandle;
    state.closeCount++;
    state.openHandles.delete(h.id);
    cancelFlags.delete(h.id);
  }

  // ---------------------------------------------------------------------------
  // Capability probe helpers (duck-typed extras consumed by detectMobileCapabilities)
  // ---------------------------------------------------------------------------

  function llmStreamSupported(): boolean {
    return true;
  }

  function ttsStreamSupported(): boolean {
    return false;
  }

  // ---------------------------------------------------------------------------
  // FfiLlmStreamingAbi implementation
  // ---------------------------------------------------------------------------

  const ffi = {
    // Capability probes — not part of the strict ABI interfaces but
    // consumed by detectMobileCapabilities() via the loose duck-type cast.
    llmStreamSupported,
    ttsStreamSupported,

    // Single-model streaming
    eliza_inference_llm_stream_open(
      _modelPath: string,
      _contextSizeTokens: number,
      _numThreads: number,
      _gpuLayers: number,
    ): FfiLlmHandle | null {
      return open();
    },

    eliza_inference_llm_stream_prefill(
      _handle: FfiLlmHandle,
      _promptTokens: Int32Array,
      _slotId: number,
    ): number {
      return prefill();
    },

    eliza_inference_llm_stream_generate(
      handle: FfiLlmHandle,
      maxNewTokens: number,
      temperature: number,
      topP: number,
      tokenCallback: TokenCallback,
    ): Promise<number> {
      return generate(handle, maxNewTokens, temperature, topP, tokenCallback);
    },

    eliza_inference_llm_stream_cancel(handle: FfiLlmHandle): void {
      cancel(handle);
    },

    eliza_inference_llm_stream_close(handle: FfiLlmHandle): void {
      close(handle);
    },

    // DFlash (speculative decoding) — Phase 2 surface.
    // Delegates to the same synthetic stream; the drafter path is
    // indistinguishable from single-model in the mock.
    eliza_inference_dflash_stream_open(
      _drafterModelPath: string,
      _verifierModelPath: string,
      _contextSizeTokens: number,
      _numThreads: number,
      _gpuLayers: number,
      _speculativeWindowSize: number,
    ): FfiLlmHandle | null {
      return open();
    },

    eliza_inference_dflash_stream_prefill(
      _handle: FfiLlmHandle,
      _promptTokens: Int32Array,
      _slotId: number,
    ): number {
      return prefill();
    },

    eliza_inference_dflash_stream_generate(
      handle: FfiLlmHandle,
      maxNewTokens: number,
      temperature: number,
      topP: number,
      tokenCallback: TokenCallback,
    ): Promise<number> {
      return generate(handle, maxNewTokens, temperature, topP, tokenCallback);
    },

    eliza_inference_dflash_stream_cancel(handle: FfiLlmHandle): void {
      cancel(handle);
    },

    eliza_inference_dflash_stream_close(handle: FfiLlmHandle): void {
      close(handle);
    },
  // TypeScript `satisfies` verifies the mock covers every required member.
  // `generate` returns `Promise<number>` which is assignable to
  // `number | Promise<number>` as declared in the interface.
  } satisfies FfiLlmStreamingAbi & FfiDflashStreamingAbi & {
    llmStreamSupported(): boolean;
    ttsStreamSupported(): boolean;
  };

  return { ffi, state };
}
