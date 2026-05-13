/**
 * End-to-end-ish contract for the streaming synthesis path.
 *
 * vitest runs under Node, so we cannot actually dlopen libomnivoice or
 * use bun:ffi's real `JSCallback`. Instead we inject a fake
 * `BunFFIModule` plus a fake `ov_synthesize` symbol that fires the
 * registered on_chunk callback N times before returning OK. That
 * exercises the full code path inside `OmnivoiceContext.synthesize`:
 *   1. JSCallback construction and pointer registration
 *   2. on_chunk slot in the ov_tts_params struct gets a non-zero value
 *   3. native-side invocations decode samples and call the JS onChunk
 *   4. accumulated samples match what the fake lib produced
 *
 * If you change the on_chunk ABI (signature, sample layout, return
 * semantics), update both this test and `src/ffi.ts` together.
 */

import { describe, expect, it } from "vitest";
import {
  _internal,
  OV_AUDIO_LAYOUT,
  OV_STATUS_OK,
  OV_TTS_PARAMS_LAYOUT,
} from "../src/ffi";

/** Build a fake `bun:ffi`-shaped module + symbols and return both. */
function makeFakeFfi(opts: {
  /** Chunks the fake lib will emit through on_chunk on each ov_synthesize. */
  chunks: Float32Array[];
}) {
  // Map of "synthetic native pointer" -> backing ArrayBufferView, so the
  // fake `ffi.ptr` / `ffi.toArrayBuffer` pair can roundtrip Float32Array
  // payloads without an actual native heap.
  const ptrTable = new Map<bigint, ArrayBufferView>();
  let nextPtr = 0x1000n;

  // JSCallback storage so ov_synthesize can dispatch back into JS.
  const callbacks = new Map<
    bigint,
    {
      fn: (...args: never[]) => unknown;
      args: readonly string[];
      returns: string;
      closed: boolean;
    }
  >();
  let nextCbPtr = 0xc000n;

  const ffi = {
    dlopen: () => {
      throw new Error("dlopen not used in fake ffi");
    },
    ptr: (view: ArrayBufferView): bigint => {
      const p = nextPtr;
      nextPtr += 0x100n;
      ptrTable.set(p, view);
      return p;
    },
    toArrayBuffer: (
      ptr: bigint,
      byteOffset = 0,
      byteLength?: number,
    ): ArrayBuffer => {
      // Null pointer with zero-length read is legal — production reads
      // `audio.samples` even when `audio.n_samples === 0` (buffered path
      // when no on_chunk fired). Return an empty buffer.
      if (ptr === 0n) return new ArrayBuffer(byteLength ?? 0);
      // For samples handed to the on_chunk callback the fake ov_synthesize
      // registers a dedicated entry below — look it up here.
      const view = ptrTable.get(ptr);
      if (!view) throw new Error(`fake toArrayBuffer: unknown ptr ${ptr}`);
      const slice = view.buffer.slice(
        view.byteOffset + byteOffset,
        view.byteOffset + byteOffset + (byteLength ?? view.byteLength),
      );
      return slice;
    },
    CString: class FakeCString {
      toString() {
        return "";
      }
    } as unknown as new (
      a: bigint,
    ) => string,
    JSCallback: class {
      readonly ptr: bigint;
      closed = false;
      constructor(
        fn: (...args: never[]) => unknown,
        def: { args: readonly string[]; returns: string },
      ) {
        this.ptr = nextCbPtr;
        nextCbPtr += 0x100n;
        callbacks.set(this.ptr, {
          fn,
          args: def.args,
          returns: def.returns,
          closed: false,
        });
      }
      close() {
        const c = callbacks.get(this.ptr);
        if (c) c.closed = true;
        this.closed = true;
      }
    } as unknown as new (
      fn: (...args: never[]) => unknown,
      def: { args: readonly string[]; returns: string },
    ) => { readonly ptr: bigint | number; close: () => void },
  };

  // What ov_synthesize observed about its params buffer — assertions read this.
  const observed: {
    onChunkPtr?: bigint;
    onChunkUserDataPtr?: bigint;
    callbackInvocations: number;
    callbackReturns: number[];
  } = {
    callbackInvocations: 0,
    callbackReturns: [],
  };

  const symbols = {
    ov_version: () => 0n,
    ov_last_error: () => 0n,
    ov_init_default_params: (_p: bigint) => {},
    ov_init: (_p: bigint) => 0x1234n,
    ov_free: (_c: bigint) => {},
    ov_tts_default_params: (_p: bigint) => {
      // Zero-init the params buffer the caller handed us. Real lib does
      // the same and then sets a few defaults; for the test we only need
      // zeros so the on_chunk slot starts at 0n.
      const view = ptrTable.get(_p);
      if (view instanceof Uint8Array) view.fill(0);
    },
    ov_synthesize: (_ctx: bigint, paramsPtr: bigint, audioPtr: bigint) => {
      const paramsView = ptrTable.get(paramsPtr);
      const audioView = ptrTable.get(audioPtr);
      if (!(paramsView instanceof Uint8Array)) {
        throw new Error("fake ov_synthesize: params not a Uint8Array");
      }
      if (!(audioView instanceof Uint8Array)) {
        throw new Error("fake ov_synthesize: audio not a Uint8Array");
      }
      const pView = new DataView(
        paramsView.buffer,
        paramsView.byteOffset,
        paramsView.byteLength,
      );
      observed.onChunkPtr = pView.getBigUint64(
        OV_TTS_PARAMS_LAYOUT.fields.on_chunk.offset,
        true,
      );
      observed.onChunkUserDataPtr = pView.getBigUint64(
        OV_TTS_PARAMS_LAYOUT.fields.on_chunk_user_data.offset,
        true,
      );

      if (observed.onChunkPtr !== 0n) {
        const cb = callbacks.get(observed.onChunkPtr);
        if (!cb) {
          throw new Error(
            `fake ov_synthesize: unknown on_chunk ptr ${observed.onChunkPtr}`,
          );
        }
        for (const chunk of opts.chunks) {
          // Register a synthetic pointer for this chunk so the JS-side
          // callback can `ffi.toArrayBuffer(ptr, 0, n*4)` it back.
          const chunkPtr = nextPtr;
          nextPtr += 0x100n;
          ptrTable.set(chunkPtr, chunk);
          observed.callbackInvocations += 1;
          const rv = cb.fn(
            chunkPtr as unknown as never,
            chunk.length as unknown as never,
            0n as unknown as never,
          );
          observed.callbackReturns.push(Number(rv));
          if (Number(rv) === 0) break; // caller asked to cancel
        }
        // streaming path: leave `out` zeroed per the ABI contract.
        return OV_STATUS_OK;
      }

      // Non-streaming path: synthesize would normally fill `out` here.
      // No test currently exercises that through this fake, so leave the
      // audio struct zeroed and let the buffered branch produce an
      // empty Float32Array.
      const aView = new DataView(
        audioView.buffer,
        audioView.byteOffset,
        audioView.byteLength,
      );
      aView.setBigUint64(OV_AUDIO_LAYOUT.fields.samples.offset, 0n, true);
      aView.setInt32(OV_AUDIO_LAYOUT.fields.n_samples.offset, 0, true);
      aView.setInt32(OV_AUDIO_LAYOUT.fields.sample_rate.offset, 24000, true);
      aView.setInt32(OV_AUDIO_LAYOUT.fields.channels.offset, 1, true);
      return OV_STATUS_OK;
    },
    ov_audio_free: (_a: bigint) => {},
  };

  return { ffi, symbols, observed, callbacks };
}

describe("plugin-omnivoice streaming synthesis", () => {
  it("fires on_chunk callback once per native chunk and accumulates samples", async () => {
    const chunkA = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const chunkB = new Float32Array([0.5, 0.6]);
    const chunkC = new Float32Array([0.7, 0.8, 0.9]);
    const chunkD = new Float32Array([1.0, -1.0]);
    const expectedChunks = [chunkA, chunkB, chunkC, chunkD];
    const { ffi, symbols, observed } = makeFakeFfi({ chunks: expectedChunks });

    const ctx = _internal.createForTest({
      ffi: ffi as never,
      symbols: symbols as never,
    });

    const seen: Float32Array[] = [];
    const result = await ctx.synthesize(
      (view, layout) => {
        // Caller writes some innocuous field — emulates synth.ts.
        view.setInt32(layout.fields.T_override.offset, 0, true);
      },
      (chunk) => {
        seen.push(new Float32Array(chunk.samples));
      },
    );

    // 1. The on_chunk slot in the params struct was set to the JSCallback.
    expect(observed.onChunkPtr).toBeDefined();
    expect(observed.onChunkPtr).not.toBe(0n);

    // 2. The callback fired once per chunk (≥3 is the contract; we sent 4).
    expect(observed.callbackInvocations).toBe(expectedChunks.length);
    expect(observed.callbackInvocations).toBeGreaterThanOrEqual(3);

    // 3. JS-side callback received samples in the same order with the
    //    same byte content.
    expect(seen).toHaveLength(expectedChunks.length);
    for (const [i, want] of expectedChunks.entries()) {
      const got = seen[i];
      if (!got) {
        throw new Error(`missing streamed chunk ${i}`);
      }
      expect(got.length).toBe(want.length);
      expect(Array.from(got)).toEqual(Array.from(want));
    }

    // 4. Result samples are the concatenation of every emitted chunk.
    const expectedTotal =
      chunkA.length + chunkB.length + chunkC.length + chunkD.length;
    expect(result.samples.length).toBe(expectedTotal);
    expect(result.sampleRate).toBe(24000);
    expect(result.channels).toBe(1);

    // 5. Native-side return values were all "continue" (1).
    expect(observed.callbackReturns.every((rv) => rv === 1)).toBe(true);
  });

  it("returns 0 (cancel) when the JS callback returns false", async () => {
    const chunks = [
      new Float32Array([1, 2, 3]),
      new Float32Array([4, 5, 6]),
      new Float32Array([7, 8, 9]),
    ];
    const { ffi, symbols, observed } = makeFakeFfi({ chunks });

    const ctx = _internal.createForTest({
      ffi: ffi as never,
      symbols: symbols as never,
    });

    let calls = 0;
    await ctx.synthesize(
      () => {},
      () => {
        calls += 1;
        if (calls === 2) return false; // request cancel after second chunk
      },
    );

    // ov_synthesize stops driving the callback as soon as it returns 0.
    expect(observed.callbackInvocations).toBe(2);
    expect(observed.callbackReturns).toEqual([1, 0]);
  });

  it("leaves on_chunk zero when no callback is provided (buffered path)", async () => {
    const { ffi, symbols, observed } = makeFakeFfi({ chunks: [] });

    const ctx = _internal.createForTest({
      ffi: ffi as never,
      symbols: symbols as never,
    });

    await ctx.synthesize(() => {});

    expect(observed.onChunkPtr).toBe(0n);
    expect(observed.onChunkUserDataPtr).toBe(0n);
    expect(observed.callbackInvocations).toBe(0);
  });
});
