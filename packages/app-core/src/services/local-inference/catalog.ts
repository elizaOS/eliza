/**
 * Eliza-curated local model catalog.
 *
 * Hand-picked as of May 2026. All entries reference public GGUF repos on
 * HuggingFace. Quants default to Q4_K_M (the usual sweet spot). When upstream
 * naming conventions drift, update `ggufFile` here — we rely on the exact
 * filename for resolved-URL construction in the downloader.
 */

import type { CatalogModel } from "./types";

export const MODEL_CATALOG: CatalogModel[] = [
  // ─── tiny / testing ─────────────────────────────────────────────────
  {
    id: "smollm2-360m",
    displayName: "SmolLM2 360M Instruct",
    hfRepo: "bartowski/SmolLM2-360M-Instruct-GGUF",
    ggufFile: "SmolLM2-360M-Instruct-Q4_K_M.gguf",
    params: "360M",
    quant: "Q4_K_M",
    sizeGb: 0.27,
    minRamGb: 1,
    category: "tiny",
    bucket: "small",
    blurb:
      "Mobile-friendly default. ~270MB on disk, runs on phones and 1GB-RAM hosts.",
  },
  {
    id: "smollm2-1.7b",
    displayName: "SmolLM2 1.7B Instruct",
    hfRepo: "bartowski/SmolLM2-1.7B-Instruct-GGUF",
    ggufFile: "SmolLM2-1.7B-Instruct-Q4_K_M.gguf",
    params: "1.7B",
    quant: "Q4_K_M",
    sizeGb: 1.1,
    minRamGb: 3,
    category: "tiny",
    bucket: "small",
    blurb:
      "Smallest genuinely useful chat model. Perfect for CI and smoke tests.",
  },
  {
    id: "llama-3.2-1b",
    displayName: "Llama 3.2 1B Instruct",
    hfRepo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
    ggufFile: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    params: "1B",
    quant: "Q4_K_M",
    sizeGb: 0.8,
    minRamGb: 2,
    category: "tiny",
    bucket: "small",
    blurb: "Ultra-light Llama for edge devices and integration tests.",
  },
  {
    id: "llama-3.2-3b",
    displayName: "Llama 3.2 3B Instruct",
    hfRepo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    ggufFile: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    params: "3B",
    quant: "Q4_K_M",
    sizeGb: 2.0,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    blurb: "Fast general chat for 8GB laptops; coherent summaries and Q&A.",
  },
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
      "Default small Qwen3.5 path. Quantized target plus hidden DFlash drafter; falls back to standard llama.cpp when the DFlash server binary is unavailable.",
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
    blurb: "Hidden DFlash drafter companion for Qwen3.5 4B.",
  },

  // ─── mid (4-8 GB) ───────────────────────────────────────────────────
  {
    id: "llama-3.1-8b",
    displayName: "Llama 3.1 8B Instruct",
    hfRepo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF",
    ggufFile: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    params: "8B",
    quant: "Q4_K_M",
    sizeGb: 4.9,
    minRamGb: 10,
    category: "chat",
    bucket: "mid",
    blurb: "Battle-tested general chat; the default 8GB-VRAM daily driver.",
  },
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
    blurb: "Hidden DFlash drafter companion for Qwen3.5 9B.",
  },
  {
    id: "gemma-2-9b",
    displayName: "Gemma 2 9B Instruct",
    hfRepo: "bartowski/gemma-2-9b-it-GGUF",
    ggufFile: "gemma-2-9b-it-Q4_K_M.gguf",
    params: "9B",
    quant: "Q4_K_M",
    sizeGb: 5.8,
    minRamGb: 12,
    category: "chat",
    bucket: "mid",
    blurb: "Google Gemma. Excellent writing quality and safety tuning.",
  },
  {
    id: "qwen2.5-coder-7b",
    displayName: "Qwen2.5 Coder 7B Instruct",
    hfRepo: "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
    ggufFile: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    params: "7B",
    quant: "Q4_K_M",
    sizeGb: 4.7,
    minRamGb: 10,
    category: "code",
    bucket: "mid",
    blurb:
      "Top small coder. Fill-in-the-middle, repo-level context, 128k window.",
  },
  {
    id: "hermes-3-llama-8b",
    displayName: "Hermes 3 Llama 3.1 8B",
    hfRepo: "bartowski/Hermes-3-Llama-3.1-8B-GGUF",
    ggufFile: "Hermes-3-Llama-3.1-8B-Q4_K_M.gguf",
    params: "8B",
    quant: "Q4_K_M",
    sizeGb: 4.9,
    minRamGb: 10,
    category: "tools",
    bucket: "mid",
    blurb: "Nous Hermes 3. Function calling, JSON mode, agentic tool use.",
  },
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

  // ─── large (8-20 GB) ────────────────────────────────────────────────
  // ─── AWQ-derived GGUFs (mid) ────────────────────────────────────────
  // AWQ-quantized GGUFs are GGUFs where AWQ scales were applied prior to
  // K-quant conversion. They load via the standard llama.cpp/llama-server
  // path — no special kernel — but tend to outperform pure K-quants on
  // long-context recall and code reasoning at the same bit-width. We
  // route them through the in-process binding by default and let the
  // dispatcher promote them to llama-server when the operator opts into
  // continuous batching or MoE expert offload.
  //
  // GPTQ-derived GGUFs exist on HF (e.g. RichardErkhov re-quants) but the
  // quality of those repos is mixed and bartowski/TheBloke do not ship
  // first-party GPTQ GGUFs. We deliberately skip GPTQ entries until a
  // first-party publisher ships them or we add a per-quant verification
  // step. Operators can still install ad-hoc GGUFs via the HF search.
  {
    id: "qwen3-coder-30b-awq-q4",
    displayName: "Qwen3 Coder 30B Instruct (AWQ→Q4_K_M)",
    hfRepo: "straino/Qwen3-Coder-30B-A3B-Instruct-AWQ-4bit-Q4_K_M-GGUF",
    ggufFile: "qwen3-coder-30b-a3b-instruct-awq-4bit-q4_k_m.gguf",
    params: "32B",
    quant: "AWQ→Q4_K_M",
    sizeGb: 18.5,
    minRamGb: 36,
    category: "code",
    bucket: "large",
    runtime: {
      optimizations: {
        // Qwen3 Coder is MoE (A3B = 3B active over 30B total). MoE expert
        // offload to CPU keeps VRAM down on workstation GPUs while the
        // active 3B path stays on the accelerator.
        moeOffload: "cpu",
        flashAttention: true,
      },
    },
    blurb:
      "AWQ scales applied before Q4_K_M conversion. Sharper code recall than the bartowski K-quants at the same bit-width; MoE expert offload defaults to CPU so 24GB VRAM workstations can run the active path comfortably.",
  },
  {
    id: "deepseek-coder-v2-lite",
    displayName: "DeepSeek Coder V2 Lite 16B",
    hfRepo: "bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF",
    ggufFile: "DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf",
    params: "16B",
    quant: "Q4_K_M",
    sizeGb: 10.4,
    minRamGb: 20,
    category: "code",
    bucket: "large",
    blurb: "MoE coder. Near-32B coding quality with ~2.4B active params.",
  },
  {
    id: "qwen2.5-coder-14b",
    displayName: "Qwen2.5 Coder 14B Instruct",
    hfRepo: "bartowski/Qwen2.5-Coder-14B-Instruct-GGUF",
    ggufFile: "Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
    params: "14B",
    quant: "Q4_K_M",
    sizeGb: 9.0,
    minRamGb: 18,
    category: "code",
    bucket: "large",
    blurb: "Sweet-spot coder for 16GB VRAM. Fluent in most languages.",
  },
  {
    id: "mistral-small-3-24b",
    displayName: "Mistral Small 3 24B Instruct",
    hfRepo: "bartowski/Mistral-Small-24B-Instruct-2501-GGUF",
    ggufFile: "Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf",
    params: "24B",
    quant: "Q4_K_M",
    sizeGb: 14.3,
    minRamGb: 28,
    category: "chat",
    bucket: "large",
    blurb: "Mistral's 2025 flagship small. Strong reasoning, creative writing.",
  },
  {
    id: "gemma-2-27b",
    displayName: "Gemma 2 27B Instruct",
    hfRepo: "bartowski/gemma-2-27b-it-GGUF",
    ggufFile: "gemma-2-27b-it-Q4_K_M.gguf",
    params: "27B",
    quant: "Q4_K_M",
    sizeGb: 16.6,
    minRamGb: 32,
    category: "chat",
    bucket: "large",
    blurb: "Largest Gemma 2. Excellent for long-form writing and reasoning.",
  },
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
    blurb: "Hidden DFlash drafter companion for Qwen3.6 27B.",
  },

  // ─── xl (>20 GB) ────────────────────────────────────────────────────
  {
    id: "qwq-32b",
    displayName: "QwQ 32B Reasoning",
    hfRepo: "bartowski/QwQ-32B-GGUF",
    ggufFile: "QwQ-32B-Q4_K_M.gguf",
    params: "32B",
    quant: "Q4_K_M",
    sizeGb: 19.9,
    minRamGb: 38,
    category: "reasoning",
    bucket: "xl",
    blurb:
      "Qwen reasoning model. Chain-of-thought, math, code. o1-class open model.",
  },
  {
    id: "deepseek-r1-distill-qwen-32b",
    displayName: "DeepSeek R1 Distill Qwen 32B",
    hfRepo: "bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF",
    ggufFile: "DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf",
    params: "32B",
    quant: "Q4_K_M",
    sizeGb: 19.9,
    minRamGb: 38,
    category: "reasoning",
    bucket: "xl",
    blurb:
      "R1 reasoning distilled into Qwen-32B. 128k context, strong math/code.",
  },

  // ─── eliza-1 series (Milady fine-tunes of Qwen3.5/3.6) ──────────────
  // Published from training/scripts/push_model_to_hf.py — quant lineage
  // is per-K-quant (one HF repo per Q4_K_M / Q5_K_M / Q6_K).
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
    blurb:
      "Cloud-tier Milady tune. Best agentic + tool-calling quality in the eliza-1 series; 128k context, 256k native window.",
  },
];

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
