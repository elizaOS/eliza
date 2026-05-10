/**
 * Eliza-curated local model catalog.
 *
 * Scope: only Milady-shippable entries. Every chat/code/reasoning entry
 * is either a TurboQuant-KV / DFlash-equipped model wired to our fused-
 * kernel runtime, or an `eliza-1` placeholder for an upcoming Milady-
 * optimized fine-tune. Generic upstream GGUFs that don't go through our
 * optimization pipeline have been removed; they are not loadable via
 * the engine's first-run defaults and we do not recommend them.
 *
 * When upstream naming conventions drift, update `ggufFile` here — we
 * rely on the exact filename for resolved-URL construction in the
 * downloader.
 */

import type { CatalogModel } from "./types";

/**
 * The model id the engine auto-loads on first run when no preference is
 * set. Must always resolve to a TurboQuant / DFlash entry — the smallest
 * one that fits the broadest range of hardware so first-light works on
 * a laptop GPU or on a phone with enough RAM headroom.
 */
export const FIRST_RUN_DEFAULT_MODEL_ID = "qwen3.5-4b-dflash";

export const MODEL_CATALOG: CatalogModel[] = [
  // ─── Qwen3.5 4B DFlash (small, default first-run) ───────────────────
  {
    id: "qwen3.5-4b-dflash",
    displayName: "Qwen3.5 4B DFlash (Q4_K_M)",
    hfRepo: "bartowski/Qwen_Qwen3.5-4B-GGUF",
    ggufFile: "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
    params: "4B",
    quant: "Q4_K_M",
    sizeGb: 2.5,
    minRamGb: 5,
    category: "chat",
    bucket: "small",
    // Qwen3.5 family native context: 131072 tokens.
    contextLength: 131072,
    tokenizerFamily: "qwen3",
    companionModelIds: ["qwen3.5-4b-dflash-drafter-q4"],
    runtime: {
      preferredBackend: "llama-server",
      optimizations: {
        requiresKernel: ["dflash"],
        flashAttention: true,
      },
      dflash: {
        drafterModelId: "qwen3.5-4b-dflash-drafter-q4",
        specType: "dflash",
        contextSize: 8192,
        draftContextSize: 256,
        draftMin: 1,
        draftMax: 16,
        gpuLayers: "auto",
        draftGpuLayers: "auto",
        disableThinking: true,
      },
    },
    blurb:
      "Default small Qwen3.5 path and the engine's first-run pick. Quantized target plus hidden DFlash drafter; runs on the milady-ai/llama-server build.",
  },
  {
    id: "qwen3.5-4b-dflash-drafter-q4",
    displayName: "Qwen3.5 4B DFlash drafter (Q4_K_M)",
    hfRepo: "psychopenguin/Qwen3.5-4B-DFlash-FP16-GGUF",
    ggufFile: "Qwen3.5-4B-DFlash-Q4_K_M.gguf",
    params: "1B",
    quant: "Q4_K_M DFlash",
    sizeGb: 0.51,
    minRamGb: 1,
    category: "drafter",
    bucket: "small",
    hiddenFromCatalog: true,
    runtimeRole: "dflash-drafter",
    companionForModelId: "qwen3.5-4b-dflash",
    tokenizerFamily: "qwen3",
    blurb: "Hidden DFlash drafter companion for Qwen3.5 4B.",
  },

  // ─── Qwen3.5 9B DFlash (mid) ────────────────────────────────────────
  {
    id: "qwen3.5-9b-dflash",
    displayName: "Qwen3.5 9B DFlash (Q4_K_M)",
    hfRepo: "bartowski/Qwen_Qwen3.5-9B-GGUF",
    ggufFile: "Qwen_Qwen3.5-9B-Q4_K_M.gguf",
    params: "9B",
    quant: "Q4_K_M",
    sizeGb: 5.4,
    minRamGb: 12,
    category: "chat",
    bucket: "mid",
    contextLength: 131072,
    tokenizerFamily: "qwen3",
    companionModelIds: ["qwen3.5-9b-dflash-drafter-q4"],
    runtime: {
      preferredBackend: "llama-server",
      optimizations: {
        requiresKernel: ["dflash"],
        flashAttention: true,
      },
      dflash: {
        drafterModelId: "qwen3.5-9b-dflash-drafter-q4",
        specType: "dflash",
        contextSize: 8192,
        draftContextSize: 256,
        draftMin: 1,
        draftMax: 16,
        gpuLayers: "auto",
        draftGpuLayers: "auto",
        disableThinking: true,
      },
    },
    blurb:
      "Workstation Qwen3.5 default. Quantized target plus hidden DFlash drafter for fast speculative decode on supported llama-server builds.",
  },
  {
    id: "qwen3.5-9b-dflash-drafter-q4",
    displayName: "Qwen3.5 9B DFlash drafter (Q4_K_M)",
    hfRepo: "psychopenguin/Qwen3.5-9B-DFlash-FP16-GGUF",
    ggufFile: "Qwen3.5-9B-DFlash-Q4_K_M.gguf",
    params: "1B",
    quant: "Q4_K_M DFlash",
    sizeGb: 0.98,
    minRamGb: 2,
    category: "drafter",
    bucket: "small",
    hiddenFromCatalog: true,
    runtimeRole: "dflash-drafter",
    companionForModelId: "qwen3.5-9b-dflash",
    tokenizerFamily: "qwen3",
    blurb: "Hidden DFlash drafter companion for Qwen3.5 9B.",
  },

  // ─── Bonsai 8B 1-bit (TurboQuant KV cache) ──────────────────────────
  {
    id: "bonsai-8b-1bit",
    displayName: "Bonsai 8B 1-bit (TurboQuant)",
    hfRepo: "apothic/bonsai-8B-1bit-turboquant",
    ggufFile: "models/gguf/8B/Bonsai-8B.gguf",
    params: "8B",
    quant: "1-bit TurboQuant",
    sizeGb: 1.2,
    minRamGb: 8,
    category: "chat",
    bucket: "mid",
    // Bonsai-8B is a Qwen3-8B 1-bit quant — inherits Qwen3's native
    // 131072 context window. The TurboQuant KV cache compression
    // (k=tbq4_0, v=tbq3_0) keeps the long-context KV memory budget
    // tractable on phone CPUs at this ceiling.
    contextLength: 131072,
    tokenizerFamily: "qwen3",
    runtime: {
      kvCache: {
        typeK: "tbq4_0",
        typeV: "tbq3_0",
        requiresFork: "apothic-turboquant",
      },
    },
    blurb:
      '1-bit weights with TurboQuant KV-cache compression (~4-4.6x KV memory cut) on phone CPU via the apothic/llama.cpp-1bit-turboquant fork. Auto-enabled when the AOSP runtime loads any GGUF whose filename contains "bonsai" (k=tbq4_0, v=tbq3_0); override with ELIZA_LLAMA_CACHE_TYPE_K/_V. Apple Silicon (Metal) and Vulkan GPU still run at full fp16 KV cache.',
  },
  {
    // DFlash variant of Bonsai-8B-1bit. Same target weights as
    // `bonsai-8b-1bit` (still 1.2 GB on disk), but the runtime block
    // declares a DFlash drafter so the AOSP dispatcher routes it through
    // the spawn-and-route llama-server path (see aosp-dflash-adapter.ts).
    //
    // Drafter: Qwen3-0.6B (Q4_K_M, ~485 MB). Picked because Bonsai-8B is a
    // Qwen3-8B 1-bit quant — it inherits the Qwen3 tokenizer (vocab
    // 151,936). DFlash speculative decoding requires the drafter to share
    // the target's exact vocabulary. See docs/porting/dflash-drafter-strategy.md
    // for the verified tokenizer state and rationale.
    id: "bonsai-8b-1bit-dflash",
    displayName: "Bonsai 8B 1-bit + DFlash (TurboQuant)",
    hfRepo: "apothic/bonsai-8B-1bit-turboquant",
    ggufFile: "models/gguf/8B/Bonsai-8B.gguf",
    params: "8B",
    quant: "1-bit TurboQuant + Q4_K_M drafter",
    sizeGb: 1.2,
    minRamGb: 8,
    category: "chat",
    bucket: "mid",
    contextLength: 131072,
    tokenizerFamily: "qwen3",
    companionModelIds: ["bonsai-8b-dflash-drafter"],
    runtime: {
      preferredBackend: "llama-server",
      kvCache: {
        typeK: "tbq4_0",
        typeV: "tbq3_0",
        requiresFork: "apothic-turboquant",
      },
      optimizations: {
        requiresKernel: ["dflash"],
      },
      dflash: {
        drafterModelId: "bonsai-8b-dflash-drafter",
        specType: "dflash",
        contextSize: 4096,
        draftContextSize: 256,
        draftMin: 4,
        draftMax: 16,
        gpuLayers: 0,
        draftGpuLayers: 0,
        disableThinking: false,
      },
    },
    blurb:
      "Bonsai-8B 1-bit with the cross-compiled AOSP llama-server speculative decoder; Qwen3-0.6B drafter (matched Qwen3 vocab) accelerates token decode while target verifies. CPU-only on phone (gpuLayers=0) — phone GPUs do not back DFlash.",
  },
  {
    id: "bonsai-8b-dflash-drafter",
    displayName: "Bonsai 8B DFlash drafter (Qwen3-0.6B Q4_K_M)",
    hfRepo: "bartowski/Qwen_Qwen3-0.6B-GGUF",
    ggufFile: "Qwen_Qwen3-0.6B-Q4_K_M.gguf",
    // Catalog enum has no "0.6B" — the existing Qwen3.5 drafter entries
    // also round their sub-1B drafters to "1B" for the same reason.
    params: "1B",
    quant: "Q4_K_M",
    sizeGb: 0.49,
    minRamGb: 2,
    category: "drafter",
    bucket: "small",
    hiddenFromCatalog: true,
    runtimeRole: "dflash-drafter",
    companionForModelId: "bonsai-8b-1bit-dflash",
    tokenizerFamily: "qwen3",
    blurb:
      "Hidden DFlash drafter companion for bonsai-8b-1bit-dflash. Qwen3-0.6B shares the target's Qwen3 tokenizer (vocab 151,936) so llama.cpp speculative-decoding accepts drafted tokens directly — no tokenizer.ggml.merges injection required. CPU-only on phone.",
  },

  // ─── Qwen3.6 27B DFlash (large) ─────────────────────────────────────
  {
    id: "qwen3.6-27b-dflash",
    displayName: "Qwen3.6 27B DFlash (Q4_K_M)",
    hfRepo: "bartowski/Qwen_Qwen3.6-27B-GGUF",
    ggufFile: "Qwen_Qwen3.6-27B-Q4_K_M.gguf",
    params: "27B",
    quant: "Q4_K_M + Q8_0 drafter",
    sizeGb: 16.1,
    minRamGb: 32,
    category: "chat",
    bucket: "large",
    // Qwen3.6 family native context: 131072 tokens.
    contextLength: 131072,
    tokenizerFamily: "qwen3",
    companionModelIds: ["qwen3.6-27b-dflash-drafter-q8"],
    runtime: {
      preferredBackend: "llama-server",
      optimizations: {
        requiresKernel: ["dflash"],
        flashAttention: true,
      },
      dflash: {
        drafterModelId: "qwen3.6-27b-dflash-drafter-q8",
        specType: "dflash",
        contextSize: 8192,
        draftContextSize: 256,
        draftMin: 1,
        draftMax: 16,
        gpuLayers: "auto",
        draftGpuLayers: "auto",
        disableThinking: true,
      },
    },
    blurb:
      "Latest large Qwen3.6 target with the recommended Q8_0 DFlash drafter. Best local/cloud llama-server path when a supported DFlash build is available.",
  },
  {
    id: "qwen3.6-27b-dflash-drafter-q8",
    displayName: "Qwen3.6 27B DFlash drafter (Q8_0)",
    hfRepo: "spiritbuun/Qwen3.6-27B-DFlash-GGUF",
    ggufFile: "dflash-draft-3.6-q8_0.gguf",
    params: "2B",
    quant: "Q8_0 DFlash",
    sizeGb: 1.75,
    minRamGb: 3,
    category: "drafter",
    bucket: "small",
    hiddenFromCatalog: true,
    runtimeRole: "dflash-drafter",
    companionForModelId: "qwen3.6-27b-dflash",
    tokenizerFamily: "qwen3",
    blurb: "Hidden DFlash drafter companion for Qwen3.6 27B.",
  },

  // ─── eliza-1 series (Milady fine-tunes of Qwen3.5/3.6) ──────────────
  // Published from training/scripts/push_model_to_hf.py — quant lineage
  // is per-K-quant (one HF repo per Q4_K_M / Q5_K_M / Q6_K). These are
  // placeholders for upcoming Milady-optimized fine-tunes; the runtime
  // block will be populated with TBQ/DFlash settings once the optimized
  // weights ship.
  {
    id: "eliza-1-2b",
    displayName: "Eliza-1 2B (Qwen3.5)",
    hfRepo: "elizaos/eliza-1-2b-gguf-q4_k_m",
    ggufFile: "eliza-1-2b-Q4_K_M.gguf",
    params: "2B",
    quant: "Q4_K_M",
    sizeGb: 1.3,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    // Inherits Qwen3.5 base context: 131072.
    contextLength: 131072,
    tokenizerFamily: "qwen3",
    blurb:
      "Milady's smallest fine-tune. 16GB-VRAM-friendly daily driver tuned for the elizaOS prompt and structured chat output.",
  },
  {
    id: "eliza-1-9b",
    displayName: "Eliza-1 9B (Qwen3.5)",
    hfRepo: "elizaos/eliza-1-9b-gguf-q4_k_m",
    ggufFile: "eliza-1-9b-Q4_K_M.gguf",
    params: "9B",
    quant: "Q4_K_M",
    sizeGb: 5.4,
    minRamGb: 12,
    category: "chat",
    bucket: "mid",
    contextLength: 131072,
    tokenizerFamily: "qwen3",
    blurb:
      "Workstation-class Milady tune with 128k context, agentic tool calling, and structured output.",
  },
  {
    id: "eliza-1-27b",
    displayName: "Eliza-1 27B (Qwen3.6)",
    hfRepo: "elizaos/eliza-1-27b-gguf-q4_k_m",
    ggufFile: "eliza-1-27b-Q4_K_M.gguf",
    params: "27B",
    quant: "Q4_K_M",
    sizeGb: 16.8,
    minRamGb: 32,
    category: "chat",
    bucket: "large",
    // Qwen3.6 base supports 131072 natively. The 256k figure in the
    // blurb refers to the upstream Qwen3.6-VL extended-context build,
    // not the GGUF here — set the conservative 131072 so the loader
    // doesn't try to allocate a window the file doesn't actually back.
    contextLength: 131072,
    tokenizerFamily: "qwen3",
    blurb:
      "Cloud-tier Milady tune. Best agentic + tool-calling quality in the eliza-1 series; 128k context, 256k native window.",
  },
];

/** Ids in the eliza-1 placeholder family — pre-optimization tunes that
 * will gain TBQ/DFlash runtime settings once the optimized weights
 * ship. Used by tests and validation that gate the catalog. */
export const ELIZA_1_PLACEHOLDER_IDS: ReadonlySet<string> = new Set([
  "eliza-1-2b",
  "eliza-1-9b",
  "eliza-1-27b",
]);

export function findCatalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/**
 * Construct the HuggingFace resolve URL for a given catalog entry.
 *
 * Respects `ELIZA_HF_BASE_URL` when set so self-hosted HF mirrors and the
 * downloader e2e test suite can redirect all downloads without touching
 * the catalog.
 */
export function buildHuggingFaceResolveUrl(model: CatalogModel): string {
  const base =
    process.env.ELIZA_HF_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://huggingface.co";
  // Encode each path segment separately so nested layouts like
  // `models/gguf/8B/Bonsai-8B.gguf` keep their slashes (HF resolve URLs
  // require a real path, not a `%2F`-mangled basename).
  const encodedPath = model.ggufFile
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}
