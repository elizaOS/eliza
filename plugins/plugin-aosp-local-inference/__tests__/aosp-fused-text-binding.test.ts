/**
 * Tests for the fused libelizainference text binding + the ABI-v9 gate that
 * enables the fused text path (the sole text backend on AOSP).
 *
 * No native library is loaded. The binding is exercised against a fake
 * symbol table + pointer helpers — a buffer registry maps the synthetic
 * pointers handed to `ptr()` back to the JS-owned views so the fake C
 * functions can read/write the marshalled struct and out-params. The goal is
 * to lock the JS↔C contract (gating, struct layout, stream sequencing) before
 * the on-device C↔FFI boundary is verified.
 */

import { describe, expect, it } from "bun:test";

import {
  type AospFfiPointerHelpers,
  type AospFusedLlmSymbols,
  type AospLlmStreamConfig,
  createAospStreamingLlmBinding,
  fusedAospTextSupported,
  streamGenerate,
} from "../src/aosp-llama-streaming";

/* -------------------------------------------------------------------- */
/* Fake bun:ffi pointer helpers backed by a registry.                   */
/* -------------------------------------------------------------------- */

function makeFakeHelpers(): {
  helpers: AospFfiPointerHelpers;
  viewFor: (ptr: bigint) => ArrayBufferView | undefined;
} {
  let next = 1n;
  const registry = new Map<bigint, ArrayBufferView>();
  const helpers: AospFfiPointerHelpers = {
    ptr(view) {
      const id = next++;
      registry.set(id, view);
      return id;
    },
    takeError() {
      return null;
    },
    cString(value) {
      return Buffer.from(`${value}\0`, "utf8");
    },
  };
  return { helpers, viewFor: (ptr) => registry.get(ptr) };
}

const DEFAULT_CONFIG: AospLlmStreamConfig = {
  maxTokens: 64,
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  repeatPenalty: 1.1,
  slotId: -1,
  promptCacheKey: null,
  draftMin: 0,
  draftMax: 0,
  mtpDrafterPath: null,
  disableThinking: false,
  contextSize: 4096,
};

/* -------------------------------------------------------------------- */
/* fusedAospTextSupported gate                                          */
/* -------------------------------------------------------------------- */

function makeProbeBinding(probes: {
  stream?: number;
  mtp?: number;
  kv?: number;
}) {
  const { helpers } = makeFakeHelpers();
  const symbols = {
    eliza_inference_llm_stream_supported: () => probes.stream ?? 0,
    eliza_inference_llm_mtp_supported: () => probes.mtp ?? 0,
    eliza_inference_llm_kv_quant_supported: () => probes.kv ?? 0,
    eliza_inference_llm_stream_open: () => 9n,
    eliza_inference_llm_stream_prefill: () => 0,
    eliza_inference_llm_stream_next: () => 1,
    eliza_inference_llm_stream_cancel: () => 0,
    eliza_inference_llm_stream_close: () => undefined,
  } as unknown as AospFusedLlmSymbols;
  return createAospStreamingLlmBinding({ ctx: 1n, symbols, helpers });
}

describe("fusedAospTextSupported (ABI-v9 gate)", () => {
  it("picks the fused path only when all three probes report 1", () => {
    expect(
      fusedAospTextSupported(makeProbeBinding({ stream: 1, mtp: 1, kv: 1 })),
    ).toBe(true);
  });

  it("falls back when the MTP probe is off", () => {
    expect(
      fusedAospTextSupported(makeProbeBinding({ stream: 1, mtp: 0, kv: 1 })),
    ).toBe(false);
  });

  it("falls back when the KV-quant probe is off", () => {
    expect(
      fusedAospTextSupported(makeProbeBinding({ stream: 1, mtp: 1, kv: 0 })),
    ).toBe(false);
  });

  it("falls back when the streaming probe is off", () => {
    expect(
      fusedAospTextSupported(makeProbeBinding({ stream: 0, mtp: 1, kv: 1 })),
    ).toBe(false);
  });

  it("falls back on a null binding (lib absent)", () => {
    expect(fusedAospTextSupported(null)).toBe(false);
  });
});

/* -------------------------------------------------------------------- */
/* Binding config marshalling + stream sequencing                       */
/* -------------------------------------------------------------------- */

describe("createAospStreamingLlmBinding", () => {
  it("threads gpuLayers, KV-cache types, and context size into the 88-byte stream config", () => {
    const { helpers, viewFor } = makeFakeHelpers();
    let capturedStruct: Buffer | undefined;
    const symbols = {
      eliza_inference_llm_stream_supported: () => 1,
      eliza_inference_llm_mtp_supported: () => 1,
      eliza_inference_llm_kv_quant_supported: () => 1,
      eliza_inference_llm_stream_open: (
        _ctx: bigint,
        cfg: bigint,
        _err: bigint,
      ) => {
        const view = viewFor(cfg);
        capturedStruct = view
          ? Buffer.from(view.buffer, view.byteOffset, view.byteLength)
          : undefined;
        return 7n;
      },
      eliza_inference_llm_stream_prefill: () => 0,
      eliza_inference_llm_stream_next: () => 1,
      eliza_inference_llm_stream_cancel: () => 0,
      eliza_inference_llm_stream_close: () => undefined,
    } as unknown as AospFusedLlmSymbols;

    const binding = createAospStreamingLlmBinding({
      ctx: 1n,
      symbols,
      helpers,
      gpuLayers: 99,
      kvCacheTypes: { cacheTypeK: "qjl1_256", cacheTypeV: "q4_polar" },
    });
    binding.llmStreamOpen({ ctx: 1n, config: { ...DEFAULT_CONFIG } });

    const struct = capturedStruct;
    if (!struct) {
      throw new Error("expected stream config struct to be captured");
    }
    expect(struct.byteLength).toBe(88);
    // off 60 = n_gpu_layers
    expect(struct.readInt32LE(60)).toBe(99);
    // off 64/72 = cache_type_k / cache_type_v pointers — non-NULL when set.
    expect(struct.readBigUInt64LE(64)).not.toBe(0n);
    expect(struct.readBigUInt64LE(72)).not.toBe(0n);
    // off 80 = context_size (ABI v9).
    expect(struct.readInt32LE(80)).toBe(4096);
  });

  it("writes n_gpu_layers = -1 (default) and NULL cache types when untuned", () => {
    const { helpers, viewFor } = makeFakeHelpers();
    let struct: Buffer | undefined;
    const symbols = {
      eliza_inference_llm_stream_open: (
        _ctx: bigint,
        cfg: bigint,
        _err: bigint,
      ) => {
        const view = viewFor(cfg);
        struct = view
          ? Buffer.from(view.buffer, view.byteOffset, view.byteLength)
          : undefined;
        return 7n;
      },
      eliza_inference_llm_stream_prefill: () => 0,
      eliza_inference_llm_stream_next: () => 1,
      eliza_inference_llm_stream_cancel: () => 0,
      eliza_inference_llm_stream_close: () => undefined,
    } as unknown as AospFusedLlmSymbols;

    const binding = createAospStreamingLlmBinding({
      ctx: 1n,
      symbols,
      helpers,
    });
    binding.llmStreamOpen({ ctx: 1n, config: { ...DEFAULT_CONFIG } });

    if (!struct) {
      throw new Error("expected stream config struct to be captured");
    }
    expect(struct.readInt32LE(60)).toBe(-1);
    expect(struct.readBigUInt64LE(64)).toBe(0n);
    expect(struct.readBigUInt64LE(72)).toBe(0n);
    expect(struct.readInt32LE(80)).toBe(4096);
  });

  it("drives open→prefill→next→close through streamGenerate", async () => {
    const { helpers } = makeFakeHelpers();
    const calls: string[] = [];
    const steps = [
      { tokens: [1, 2], text: "hel", done: false },
      { tokens: [3], text: "lo", done: true },
    ];
    let stepIdx = 0;
    const symbols = {
      eliza_inference_llm_stream_supported: () => 1,
      eliza_inference_llm_stream_open: () => {
        calls.push("open");
        return 5n;
      },
      eliza_inference_llm_stream_prefill: () => {
        calls.push("prefill");
        return 0;
      },
      eliza_inference_llm_stream_next: (
        _stream: bigint,
        _tokensOut: bigint,
        _tokensCap: bigint,
        numTokensOut: bigint,
        textOut: bigint,
        _textCap: bigint,
        _drafted: bigint,
        _accepted: bigint,
        _err: bigint,
      ) => {
        calls.push("next");
        const step = steps[stepIdx++];
        if (!step) {
          throw new Error("mock stream exhausted unexpectedly");
        }
        // Write the step's text into the textOut view + token count.
        const textView = textRegistry.get(textOut);
        if (textView) {
          const bytes = Buffer.from(step.text, "utf8");
          new Uint8Array(
            textView.buffer,
            textView.byteOffset,
            textView.byteLength,
          ).set(bytes);
        }
        const numView = numRegistry.get(numTokensOut);
        if (numView) {
          new BigUint64Array(numView.buffer, numView.byteOffset, 1)[0] = BigInt(
            step.tokens.length,
          );
        }
        return step.done ? 1 : 0;
      },
      eliza_inference_llm_stream_cancel: () => 0,
      eliza_inference_llm_stream_close: () => {
        calls.push("close");
      },
    } as unknown as AospFusedLlmSymbols;

    // The binding's llmStreamNext allocates fresh out-views per call and hands
    // them to ptr(); intercept ptr() to track the text + count views so the
    // fake `next` can write into them.
    const textRegistry = new Map<bigint, ArrayBufferView>();
    const numRegistry = new Map<bigint, ArrayBufferView>();
    let next = 100n;
    const trackingHelpers: AospFfiPointerHelpers = {
      ptr(view) {
        const id = next++;
        // The first BigUint64Array(1) per next() is num_tokens_out; the first
        // Uint8Array is text_out. Track both kinds.
        if (view instanceof BigUint64Array && view.length === 1) {
          numRegistry.set(id, view);
        } else if (view instanceof Uint8Array) {
          textRegistry.set(id, view);
        }
        return id;
      },
      takeError: () => null,
      cString: helpers.cString,
    };

    const binding = createAospStreamingLlmBinding({
      ctx: 1n,
      symbols,
      helpers: trackingHelpers,
    });
    const result = await streamGenerate(binding, {
      ctx: 1n,
      config: { ...DEFAULT_CONFIG },
      promptTokens: new Int32Array([7, 8, 9]),
    });

    expect(result.text).toBe("hello");
    expect(calls[0]).toBe("open");
    expect(calls[1]).toBe("prefill");
    expect(calls).toContain("next");
    expect(calls.at(-1)).toBe("close");
  });
});
