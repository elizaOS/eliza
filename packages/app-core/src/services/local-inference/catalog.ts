/**
 * Milady-curated local model catalog.
 *
 * Hand-picked as of April 2026. All entries reference public GGUF repos on
 * HuggingFace. Quants default to Q4_K_M (the usual sweet spot). When upstream
 * naming conventions drift, update `ggufFile` here — we rely on the exact
 * filename for resolved-URL construction in the downloader.
 */

import type { CatalogModel } from "./types";

export const MODEL_CATALOG: CatalogModel[] = [
  // ─── embeddings (Milady-local TEXT_EMBEDDING GGUF) ───────────────────
  {
    id: "bge-small-en-v1.5-embed",
    displayName: "BGE small English v1.5 (embedding)",
    hfRepo: "ChristianAzinn/bge-small-en-v1.5-gguf",
    ggufFile: "bge-small-en-v1.5.Q4_K_M.gguf",
    params: "33M",
    quant: "Q4_K_M",
    sizeGb: 133 / 1024,
    minRamGb: 2,
    category: "embedding",
    bucket: "small",
    embeddingDimensions: 384,
    blurb:
      "384-dim sentence embeddings. Same compact default as Milady’s local-embedding preset — ideal for CPU-only vectors while chat stays on Eliza Cloud.",
  },

  // ─── tiny / testing ─────────────────────────────────────────────────
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
    id: "qwen2.5-3b",
    displayName: "Qwen2.5 3B Instruct",
    hfRepo: "bartowski/Qwen2.5-3B-Instruct-GGUF",
    ggufFile: "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
    params: "3B",
    quant: "Q4_K_M",
    sizeGb: 2.0,
    minRamGb: 4,
    category: "chat",
    bucket: "small",
    blurb:
      "Punchy small model with strong multilingual and instruction following.",
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
    id: "qwen2.5-7b",
    displayName: "Qwen2.5 7B Instruct",
    hfRepo: "bartowski/Qwen2.5-7B-Instruct-GGUF",
    ggufFile: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    params: "7B",
    quant: "Q4_K_M",
    sizeGb: 4.7,
    minRamGb: 10,
    category: "chat",
    bucket: "mid",
    blurb: "Strong reasoning and multilingual chat; rivals Llama-3.1-8B.",
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

  // ─── large (8-20 GB) ────────────────────────────────────────────────
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
];

export function findCatalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/**
 * Construct the HuggingFace resolve URL for a given catalog entry.
 *
 * Respects `MILADY_HF_BASE_URL` when set so self-hosted HF mirrors and the
 * downloader e2e test suite can redirect all downloads without touching
 * the catalog.
 */
export function buildHuggingFaceResolveUrl(model: CatalogModel): string {
  const base =
    process.env.MILADY_HF_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://huggingface.co";
  return `${base}/${model.hfRepo}/resolve/main/${encodeURIComponent(
    model.ggufFile,
  )}?download=true`;
}
