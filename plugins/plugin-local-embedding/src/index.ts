import fs from "node:fs";
import os from "node:os";
import path, { basename } from "node:path";
import type {
  DetokenizeTextParams,
  ModelTypeName,
  TextEmbeddingParams,
  TokenizeTextParams,
} from "@elizaos/core";
import { type IAgentRuntime, logger, ModelType, type Plugin } from "@elizaos/core";
import {
  getLlama,
  type Llama,
  type LlamaEmbeddingContext,
  LlamaLogLevel,
  type LlamaModel,
} from "node-llama-cpp";
import { type Config, validateConfig } from "./environment";
import { type EmbeddingModelSpec, MODEL_SPECS, type ModelSpec } from "./types";
import { DownloadManager } from "./utils/downloadManager";
import { getPlatformManager } from "./utils/platform";
import { TokenizerManager } from "./utils/tokenizerManager";

const CORRUPTED_MODEL_ERROR_SIGNATURES = [
  "data is not within the file bounds",
  "failed to load model",
  "model is corrupted",
  "data of tensor",
  "is out of bounds",
];
const CONTEXT_LIMIT_ERROR_SIGNATURES = [
  "input is longer than the context size",
  "context size",
  "too many tokens",
  "exceeds context",
];
const NODE_LLAMA_NOISY_LOAD_ERROR_PATTERNS = [
  "llama_model_load:",
  "llama_model_load_from_file_impl: failed to load model",
];

/**
 * Hardware-aware backend probe order.
 *
 * node-llama-cpp's `getLlama({ gpu: "auto" })` already enumerates the
 * available GPU back-ends and picks the best, but it does so silently —
 * we want to log the chosen backend (so dev-server logs make the
 * acceleration path obvious) and we want a deterministic fallback chain
 * that respects:
 *
 *   1. CUDA — desktop NVIDIA. Highest throughput when present.
 *   2. Metal — Apple Silicon (the binding maps "auto" -> Metal there).
 *   3. Vulkan — Linux/Windows discrete GPUs without CUDA.
 *   4. NEON CPU — aarch64 (Apple Silicon CPU fallback, AOSP arm64,
 *      Pixel/Tensor) where llama.cpp's NEON kernels handily beat
 *      generic SIMD.
 *   5. Generic CPU — last resort.
 *
 * We don't probe each backend by trying to load — that would burn GPU
 * memory just to check capabilities. Instead we read OS / arch hints
 * (CUDA env, darwin/arm64 detection) plus the binding's own
 * `supportsGpuOffloading` heuristic.
 */
export type BackendKind = "cuda" | "metal" | "vulkan" | "neon-cpu" | "cpu";

export interface BackendChoice {
  backend: BackendKind;
  /** Value forwarded to `getLlama({ gpu })`. */
  gpuOption: false | "auto" | "cuda" | "metal" | "vulkan";
  /** Set when the user forced a non-GPU backend via env. */
  forced: boolean;
  reason: string;
}

export function chooseBackend(config: Config): BackendChoice {
  if (config.LOCAL_EMBEDDING_FORCE_CPU) {
    const isAarch64 = process.arch === "arm64" || process.arch === "arm";
    return {
      backend: isAarch64 ? "neon-cpu" : "cpu",
      gpuOption: false,
      forced: true,
      reason: "LOCAL_EMBEDDING_FORCE_CPU=1",
    };
  }
  // CUDA hint: env var present and non-empty (Linux + Windows path).
  const cudaHint = process.env.CUDA_VISIBLE_DEVICES?.trim();
  if (cudaHint && cudaHint !== "" && cudaHint !== "-1") {
    return {
      backend: "cuda",
      gpuOption: "cuda",
      forced: false,
      reason: `CUDA_VISIBLE_DEVICES=${cudaHint}`,
    };
  }
  if (process.platform === "darwin") {
    return {
      backend: "metal",
      gpuOption: "metal",
      forced: false,
      reason: "Darwin — Metal via node-llama-cpp",
    };
  }
  if (process.platform === "linux" || process.platform === "win32") {
    // Let the binding pick; falls through to Vulkan / CUDA when the
    // build supports it, otherwise to CPU.
    return {
      backend: "vulkan",
      gpuOption: "auto",
      forced: false,
      reason: `${process.platform} — auto (Vulkan/CUDA when available)`,
    };
  }
  const isAarch64 = process.arch === "arm64" || process.arch === "arm";
  return {
    backend: isAarch64 ? "neon-cpu" : "cpu",
    gpuOption: false,
    forced: false,
    reason: `${process.platform}/${process.arch} — CPU only`,
  };
}

type EmbeddingModelHint = {
  pattern: RegExp;
  repo: string;
  dimensions: number;
  contextSize: number;
};

const EMBEDDING_MODEL_HINTS: EmbeddingModelHint[] = [
  {
    pattern: /nomic-embed-text-v1\.5/i,
    repo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
    dimensions: 768,
    contextSize: 8192,
  },
  {
    pattern: /bge-small-en-v1\.5/i,
    repo: "ChristianAzinn/bge-small-en-v1.5-gguf",
    dimensions: 384,
    contextSize: 512,
  },
  {
    pattern: /e5-mistral-7b/i,
    repo: "dranger003/e5-mistral-7b-instruct-GGUF",
    dimensions: 4096,
    contextSize: 32768,
  },
];

export type PoolingStrategy = "mean" | "cls" | "last";

export function parsePoolingStrategy(value: string | undefined): PoolingStrategy {
  switch (value?.trim().toLowerCase()) {
    case "cls":
      return "cls";
    case "last":
      return "last";
    case undefined:
    case "":
    case "mean":
      return "mean";
    default:
      logger.warn({ value }, "Unknown LOCAL_EMBEDDING_POOLING; falling back to 'mean'");
      return "mean";
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function isCorruptedModelLoadError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return CORRUPTED_MODEL_ERROR_SIGNATURES.some((signature) => message.includes(signature));
}

function isContextLimitError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return CONTEXT_LIMIT_ERROR_SIGNATURES.some((signature) => message.includes(signature));
}

function shouldSuppressNodeLlamaLoadError(message: string): boolean {
  const lower = message.toLowerCase();
  return NODE_LLAMA_NOISY_LOAD_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

function inferEmbeddingModelHint(modelName: string): EmbeddingModelHint | null {
  const match = EMBEDDING_MODEL_HINTS.find((hint) => hint.pattern.test(modelName));
  return match ?? null;
}

function resolveEmbeddingModelSpec(
  config: Config,
  fallback: EmbeddingModelSpec
): EmbeddingModelSpec {
  const modelName = config.LOCAL_EMBEDDING_MODEL || fallback.name;
  const hint = inferEmbeddingModelHint(modelName);

  return {
    ...fallback,
    name: modelName,
    repo: config.LOCAL_EMBEDDING_MODEL_REPO?.trim() || hint?.repo || fallback.repo,
    dimensions: config.LOCAL_EMBEDDING_DIMENSIONS ?? hint?.dimensions ?? fallback.dimensions,
    contextSize: config.LOCAL_EMBEDDING_CONTEXT_SIZE ?? hint?.contextSize ?? fallback.contextSize,
  };
}

function readMagicHeader(filePath: string): {
  bytesRead: number;
  magic: string;
} {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const header = Buffer.alloc(4);
      const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
      return { bytesRead, magic: header.toString("ascii", 0, 4) };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { bytesRead: 0, magic: "" };
  }
}

function isValidGgufFile(filePath: string): boolean {
  const { bytesRead, magic } = readMagicHeader(filePath);
  return bytesRead === 4 && magic === "GGUF";
}

function safeUnlink(filePath: string): void {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn(
      `Failed to remove model file ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Sliding-window chunking with overlap, tuned for embedding models.
 *
 * WHY this is here (per CLAUDE.md, this is one of the rare load-bearing
 * comments): embedding models have a *hard* context window — bge-small
 * is 512 tokens, nomic-embed is 8k. Inputs longer than that have to be
 * split before embedding, then re-aggregated.
 *
 * Strategy:
 *   1. Approximate token count as `Math.ceil(text.length / 4)` —
 *      conventional GPT/Llama upper bound for English. The model's
 *      tokenizer is the source of truth at embed time; the approximation
 *      is only used to decide whether splitting is *needed* and how many
 *      chunks to make.
 *   2. If estimated tokens fit, return one chunk.
 *   3. Otherwise, split into N chunks of `windowTokens` with
 *      `overlapTokens` overlap. Overlap stops semantic units from being
 *      sliced exactly between chunks (a paragraph boundary in chunk A
 *      shouldn't lose all context for the start of chunk B).
 *   4. Embed each chunk and average-pool the resulting vectors. Average
 *      pool with renormalisation is the simplest aggregation that gives
 *      cosine-similarity-stable representations for retrieval over long
 *      documents — see Sentence-BERT's mean-pool approach. Max-pool
 *      tends to over-emphasise outlier dimensions; CLS-pool needs a
 *      special token the embedding head was trained to use, which not
 *      every embedding model exposes.
 *   5. L2-normalise the pooled vector unless the caller disabled it.
 */
export function chunkText(text: string, windowTokens: number, overlapTokens: number): string[] {
  const charsPerToken = 4;
  const windowChars = Math.max(1, windowTokens * charsPerToken);
  const overlapChars = Math.max(0, Math.min(windowChars - 1, overlapTokens * charsPerToken));
  if (text.length <= windowChars) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + windowChars, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - overlapChars;
  }
  return chunks;
}

export function meanPool(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    throw new Error("meanPool received an empty vector list");
  }
  const dim = vectors[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const vec of vectors) {
    if (vec.length !== dim) {
      throw new Error(`Cannot mean-pool vectors of differing dimensions (${vec.length} vs ${dim})`);
    }
    for (let i = 0; i < dim; i += 1) out[i] += vec[i];
  }
  for (let i = 0; i < dim; i += 1) out[i] /= vectors.length;
  return out;
}

export function l2Normalize(embedding: number[]): number[] {
  let squareSum = 0;
  for (const v of embedding) squareSum += v * v;
  const norm = Math.sqrt(squareSum);
  if (norm === 0) return embedding;
  return embedding.map((v) => v / norm);
}

export function alignDimensions(embedding: number[], target: number): number[] {
  if (target <= 0 || embedding.length === target) return embedding;
  logger.warn(
    { observed: embedding.length, target },
    "Embedding dimension mismatch; padding/truncating to declared target"
  );
  if (embedding.length > target) return embedding.slice(0, target);
  return [...embedding, ...new Array(target - embedding.length).fill(0)];
}

export class LocalEmbeddingManager {
  private static instance: LocalEmbeddingManager | null = null;
  private llama: Llama | undefined;
  private embeddingModel: LlamaModel | undefined;
  private embeddingContext: LlamaEmbeddingContext | undefined;
  private modelPath!: string;
  private embeddingModelPath!: string;
  private cacheDir!: string;
  private tokenizerManager!: TokenizerManager;
  private downloadManager!: DownloadManager;
  private activeModelConfig: ModelSpec;
  private embeddingModelConfig: EmbeddingModelSpec;
  private config: Config | null = null;
  private backendChoice: BackendChoice | null = null;
  private pooling: PoolingStrategy = "mean";
  private normalize = true;
  private batchSize = 16;
  private overlapTokens = 64;

  private embeddingInitialized = false;
  private environmentInitialized = false;
  private embeddingInitializingPromise: Promise<void> | null = null;
  private environmentInitializingPromise: Promise<void> | null = null;
  private modelsDir!: string;

  private constructor() {
    this.config = validateConfig();
    this._setupCacheDir();
    this.activeModelConfig = MODEL_SPECS.small;
    this.embeddingModelConfig = MODEL_SPECS.embedding;
  }

  private _postValidateInit(): void {
    this._setupModelsDir();
    this.downloadManager = DownloadManager.getInstance(this.cacheDir, this.modelsDir);
    this.tokenizerManager = TokenizerManager.getInstance(this.cacheDir, this.modelsDir);
  }

  private _setupModelsDir(): void {
    const modelsDirEnv = this.config?.MODELS_DIR?.trim() || process.env.MODELS_DIR?.trim();
    if (modelsDirEnv) {
      this.modelsDir = path.resolve(modelsDirEnv);
      logger.info("Using models directory from MODELS_DIR environment variable:", this.modelsDir);
    } else {
      this.modelsDir = path.join(os.homedir(), ".eliza", "models");
      logger.info(
        "MODELS_DIR environment variable not set, using default models directory:",
        this.modelsDir
      );
    }
    if (!fs.existsSync(this.modelsDir)) {
      fs.mkdirSync(this.modelsDir, { recursive: true });
      logger.debug("Ensured models directory exists (created):", this.modelsDir);
    }
  }

  private _setupCacheDir(): void {
    const cacheDirEnv = this.config?.CACHE_DIR?.trim() || process.env.CACHE_DIR?.trim();
    if (cacheDirEnv) {
      this.cacheDir = path.resolve(cacheDirEnv);
      logger.info("Using cache directory from CACHE_DIR environment variable:", this.cacheDir);
    } else {
      this.cacheDir = path.join(os.homedir(), ".eliza", "cache");
    }
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      logger.debug("Ensured cache directory exists (created):", this.cacheDir);
    }
  }

  public static getInstance(): LocalEmbeddingManager {
    if (!LocalEmbeddingManager.instance) {
      LocalEmbeddingManager.instance = new LocalEmbeddingManager();
    }
    return LocalEmbeddingManager.instance;
  }

  public async initializeEnvironment(): Promise<void> {
    if (this.environmentInitialized) return;
    if (this.environmentInitializingPromise) {
      await this.environmentInitializingPromise;
      return;
    }

    this.environmentInitializingPromise = (async () => {
      try {
        logger.info("Initializing embedding plugin environment...");
        this.config = await validateConfig();
        this.embeddingModelConfig = resolveEmbeddingModelSpec(this.config, MODEL_SPECS.embedding);
        this.backendChoice = chooseBackend(this.config);
        this.pooling = parsePoolingStrategy(this.config.LOCAL_EMBEDDING_POOLING);
        this.normalize = this.config.LOCAL_EMBEDDING_NORMALIZE !== false;
        this.batchSize = Math.max(1, this.config.LOCAL_EMBEDDING_BATCH_SIZE ?? 16);
        this.overlapTokens = Math.max(0, this.config.LOCAL_EMBEDDING_CHUNK_OVERLAP ?? 64);

        this._postValidateInit();
        this.embeddingModelPath = path.join(this.modelsDir, this.embeddingModelConfig.name);

        logger.info(
          {
            model: this.embeddingModelConfig.name,
            repo: this.embeddingModelConfig.repo,
            dimensions: this.embeddingModelConfig.dimensions,
            contextSize: this.embeddingModelConfig.contextSize,
            backend: this.backendChoice.backend,
            backendReason: this.backendChoice.reason,
            pooling: this.pooling,
            normalize: this.normalize,
            batchSize: this.batchSize,
            overlapTokens: this.overlapTokens,
          },
          "Resolved embedding model spec + backend"
        );

        this.ensureEmbeddingModelFileIsValid();
        this.environmentInitialized = true;
        logger.success("Embedding environment initialization complete");
      } catch (error) {
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          "Embedding environment validation failed"
        );
        this.environmentInitializingPromise = null;
        throw error;
      }
    })();

    await this.environmentInitializingPromise;
  }

  private async downloadModel(
    modelType: ModelTypeName,
    customModelSpec?: ModelSpec,
    forceDownload = false
  ): Promise<boolean> {
    let modelSpec: ModelSpec;
    let modelPathToDownload: string;

    await this.initializeEnvironment();

    if (customModelSpec) {
      modelSpec = customModelSpec;
      modelPathToDownload =
        modelType === ModelType.TEXT_EMBEDDING ? this.embeddingModelPath : this.modelPath;
    } else if (modelType === ModelType.TEXT_EMBEDDING) {
      modelSpec = this.embeddingModelConfig;
      modelPathToDownload = this.embeddingModelPath;
      this.ensureEmbeddingModelFileIsValid();
    } else {
      modelSpec = MODEL_SPECS.small;
      modelPathToDownload = this.modelPath;
    }

    try {
      return await this.downloadManager.downloadModel(
        modelSpec,
        modelPathToDownload,
        forceDownload
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          modelType,
          modelPath: modelPathToDownload,
        },
        "Embedding model download failed"
      );
      throw error;
    }
  }

  public async checkPlatformCapabilities(): Promise<void> {
    try {
      const platformManager = getPlatformManager();
      await platformManager.initialize();
      const capabilities = platformManager.getCapabilities();
      logger.info(
        {
          platform: capabilities.platform,
          gpu: capabilities.gpu?.type || "none",
          recommendedModel: capabilities.recommendedModelSize,
          supportedBackends: capabilities.supportedBackends,
        },
        "Platform capabilities detected"
      );
    } catch (error) {
      logger.warn(error instanceof Error ? error : String(error), "Platform detection failed");
    }
  }

  async initialize(_modelType: ModelTypeName = ModelType.TEXT_SMALL): Promise<void> {
    await this.initializeEnvironment();
  }

  public getEmbeddingDimensions(): number {
    return this.embeddingModelConfig.dimensions;
  }

  public getBackendChoice(): BackendChoice {
    if (!this.backendChoice) {
      this.backendChoice = chooseBackend(this.config ?? validateConfig());
    }
    return this.backendChoice;
  }

  private ensureEmbeddingModelFileIsValid(): void {
    if (!this.embeddingModelPath || !fs.existsSync(this.embeddingModelPath)) return;
    if (isValidGgufFile(this.embeddingModelPath)) return;
    const { bytesRead, magic } = readMagicHeader(this.embeddingModelPath);
    logger.warn(
      { embeddingModelPath: this.embeddingModelPath, bytesRead, magic },
      "Invalid embedding model file detected; removing corrupt file before download/retry"
    );
    safeUnlink(this.embeddingModelPath);
  }

  private async ensureLlama(): Promise<void> {
    if (this.llama) return;
    const choice = this.getBackendChoice();
    this.llama = await getLlama({
      gpu: choice.gpuOption,
      logLevel: LlamaLogLevel.error,
      logger: (level, message) => {
        if (level !== "error" && level !== "fatal") return;
        const text = message.trim();
        if (!text) return;
        if (shouldSuppressNodeLlamaLoadError(text)) return;
        logger.error(`[node-llama-cpp] ${text}`);
      },
    });
    logger.info(
      { backend: choice.backend, reason: choice.reason },
      "node-llama-cpp embedding runtime initialised"
    );
  }

  private async loadEmbeddingModel(): Promise<void> {
    this.ensureEmbeddingModelFileIsValid();
    const gpuLayers =
      this.config?.LOCAL_EMBEDDING_GPU_LAYERS === -1
        ? "auto"
        : (this.config?.LOCAL_EMBEDDING_GPU_LAYERS ?? 0);
    const useMmap = this.config?.LOCAL_EMBEDDING_USE_MMAP ?? true;

    if (!this.llama) {
      throw new Error(
        "[plugin-local-embedding] llama runtime is not initialized; cannot load embedding model"
      );
    }

    this.embeddingModel = await this.llama.loadModel({
      modelPath: this.embeddingModelPath,
      gpuLayers: gpuLayers as number | "auto" | undefined,
      vocabOnly: false,
      useMmap,
    });

    this.embeddingContext = await this.embeddingModel.createEmbeddingContext({
      contextSize: this.embeddingModelConfig.contextSize,
      batchSize: 512,
    });
  }

  private async initializeEmbeddingWithRecovery(): Promise<void> {
    logger.info("Loading embedding model:", basename(this.embeddingModelPath));
    try {
      await this.loadEmbeddingModel();
      logger.success("Embedding model initialized successfully");
      return;
    } catch (error) {
      if (!isCorruptedModelLoadError(error)) {
        throw error;
      }
      logger.warn(
        {
          error: getErrorMessage(error),
          embeddingModelPath: this.embeddingModelPath,
        },
        "Embedding model appears corrupted/incomplete; deleting and re-downloading"
      );
      this.embeddingModel = undefined;
      this.embeddingContext = undefined;
      safeUnlink(this.embeddingModelPath);
      await this.downloadModel(ModelType.TEXT_EMBEDDING, undefined, true);
      this.ensureEmbeddingModelFileIsValid();
      await this.loadEmbeddingModel();
      logger.success("Embedding model recovered after re-download");
    }
  }

  public async initializeEmbedding(): Promise<void> {
    try {
      await this.initializeEnvironment();
      logger.info({ modelsDir: this.modelsDir }, "Initializing embedding model...");
      if (!fs.existsSync(this.modelsDir)) {
        fs.mkdirSync(this.modelsDir, { recursive: true });
      }
      await this.downloadModel(ModelType.TEXT_EMBEDDING);
      this.ensureEmbeddingModelFileIsValid();
      await this.ensureLlama();
      if (!this.embeddingModel) {
        await this.initializeEmbeddingWithRecovery();
      }
    } catch (error) {
      if (isCorruptedModelLoadError(error)) {
        safeUnlink(this.embeddingModelPath);
      }
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          modelsDir: this.modelsDir,
          embeddingModelPath: this.embeddingModelPath,
        },
        "Embedding initialization failed"
      );
      throw error;
    }
  }

  /**
   * Generate a single embedding for `text`.
   *
   * Inputs longer than the model's context window are split into
   * overlapping chunks (see `chunkText` for the WHY), each chunk is
   * embedded individually, and the results are pooled (default mean)
   * before being optionally L2-normalised. node-llama-cpp's
   * `LlamaEmbeddingContext.getEmbeddingFor()` doesn't expose the raw
   * per-token tensor, so `cls`/`last` pooling reduces to the same
   * pooled-output the binding returns — we still record the requested
   * pooling for telemetry and as a forward-compat seam if the binding
   * grows a per-token surface.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const result = await this.generateEmbeddings([text]);
    return result[0];
  }

  /**
   * Generate embeddings for an array of inputs in a single call.
   *
   * Batches sequentially through node-llama-cpp's embedding context (the
   * binding does not expose a true batched-embed C++ API at this time —
   * 3.18.x's `LlamaEmbeddingContext.getEmbeddingFor()` is single-input
   * only). We still expose the array shape so callers can let us manage
   * the batch concurrency rather than serialising through `Promise.all`
   * at every call-site.
   */
  async generateEmbeddings(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    await this.lazyInitEmbedding();
    if (!this.embeddingModel || !this.embeddingContext) {
      throw new Error("Failed to initialize embedding model");
    }

    const ctxTokens = this.embeddingModelConfig.contextSize;
    // Reserve a small slack for tokenizer overhead. 92% of context
    // keeps us safely under the limit while still using most of it.
    const windowTokens = Math.max(8, Math.floor(ctxTokens * 0.92));
    const out: number[][] = new Array(inputs.length);

    for (let start = 0; start < inputs.length; start += this.batchSize) {
      const slice = inputs.slice(start, start + this.batchSize);
      // Each chunk-embed is awaited in order: the binding is single-
      // contexted (one inflight `getEmbeddingFor` per context). Running
      // them concurrently against the same context corrupts state.
      for (let i = 0; i < slice.length; i += 1) {
        const text = slice[i];
        if (!text || text.trim().length === 0) {
          out[start + i] = new Array(this.getEmbeddingDimensions()).fill(0);
          continue;
        }
        out[start + i] = await this.embedSingleInput(text, windowTokens);
      }
    }
    return out;
  }

  private async embedSingleInput(text: string, windowTokens: number): Promise<number[]> {
    const chunks = chunkText(text, windowTokens, this.overlapTokens);
    const vectors: number[][] = [];
    for (const chunk of chunks) {
      const vec = await this.embedRawWithRetry(chunk);
      vectors.push(alignDimensions(vec, this.getEmbeddingDimensions()));
    }
    const pooled = vectors.length === 1 ? vectors[0] : meanPool(vectors);
    return this.normalize ? l2Normalize(pooled) : pooled;
  }

  private async embedRawWithRetry(text: string): Promise<number[]> {
    if (!this.embeddingContext) {
      throw new Error("Embedding context not initialised");
    }
    let candidate = text;
    while (true) {
      try {
        const result = await this.embeddingContext.getEmbeddingFor(candidate);
        return [...result.vector];
      } catch (error) {
        if (!isContextLimitError(error)) {
          if (isCorruptedModelLoadError(error)) {
            safeUnlink(this.embeddingModelPath);
            this.embeddingModel = undefined;
            this.embeddingContext = undefined;
            this.embeddingInitialized = false;
          }
          throw error instanceof Error
            ? error
            : new Error(`Embedding generation failed: ${String(error)}`);
        }
        const next =
          candidate.length > 1 ? candidate.slice(0, Math.floor(candidate.length / 2)) : candidate;
        if (next === candidate) throw error;
        logger.warn(
          { fromChars: candidate.length, toChars: next.length },
          "Chunk exceeded model context; halving and retrying"
        );
        candidate = next;
      }
    }
  }

  private async lazyInitEmbedding(): Promise<void> {
    if (this.embeddingInitialized) return;
    if (!this.embeddingInitializingPromise) {
      this.embeddingInitializingPromise = (async () => {
        try {
          await this.initializeEnvironment();
          await this.downloadModel(ModelType.TEXT_EMBEDDING);
          this.ensureEmbeddingModelFileIsValid();
          await this.ensureLlama();
          await this.initializeEmbeddingWithRecovery();
          this.embeddingInitialized = true;
          logger.info("Embedding model initialized successfully");
        } catch (error) {
          if (isCorruptedModelLoadError(error)) {
            safeUnlink(this.embeddingModelPath);
          }
          this.embeddingInitializingPromise = null;
          throw error;
        }
      })();
    }
    await this.embeddingInitializingPromise;
  }

  public getTokenizerManager(): TokenizerManager {
    return this.tokenizerManager;
  }

  public getActiveModelConfig(): ModelSpec {
    return this.activeModelConfig;
  }
}

const localEmbeddingManager = LocalEmbeddingManager.getInstance();

export const localEmbeddingPlugin: Plugin = {
  name: "local-embedding",
  description:
    "Hardware-aware local embedding plugin (CUDA/Metal/Vulkan/NEON/CPU) backed by node-llama-cpp",
  // Higher priority ensures local embeddings are used instead of remote
  // providers (e.g. ElizaCloud, OpenAI) even when plugins register in
  // parallel and the registration order is non-deterministic.
  priority: 10,

  async init(_config: unknown, _runtime: IAgentRuntime) {
    logger.info("Initializing local embedding plugin...");
    try {
      await localEmbeddingManager.initializeEnvironment();
      await localEmbeddingManager.checkPlatformCapabilities();

      const config = validateConfig();
      const modelsDir = config.MODELS_DIR || path.join(os.homedir(), ".eliza", "models");
      const embeddingModelPath = path.join(modelsDir, config.LOCAL_EMBEDDING_MODEL);
      if (fs.existsSync(embeddingModelPath)) {
        logger.info(
          { embeddingModelPath: basename(embeddingModelPath) },
          "Embedding model file is present"
        );
      } else {
        logger.info(
          { embeddingModelPath: basename(embeddingModelPath) },
          "Embedding model file not present yet; it will be downloaded on first use"
        );
      }
      logger.success("Local embedding plugin initialized");
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Failed to initialize local embedding plugin"
      );
      throw error instanceof Error
        ? error
        : new Error(`Failed to initialize local embedding plugin: ${String(error)}`);
    }
  },

  models: {
    // Single-input only — `@elizaos/core`'s TEXT_EMBEDDING contract is
    // (string | TextEmbeddingParams) -> number[]. Callers wanting the
    // batched path import `LocalEmbeddingManager` directly:
    //
    //   import { LocalEmbeddingManager } from "@elizaos/plugin-local-embedding";
    //   const vecs = await LocalEmbeddingManager.getInstance().generateEmbeddings(inputs);
    //
    // If the core contract grows array support later, widen this handler
    // to dispatch on Array.isArray(params).
    [ModelType.TEXT_EMBEDDING]: async (
      _runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      try {
        if (params == null) {
          return new Array(localEmbeddingManager.getEmbeddingDimensions()).fill(0);
        }
        let text: string | undefined;
        if (typeof params === "string") {
          text = params;
        } else if (params && typeof params === "object" && "text" in params) {
          text = params.text;
        }
        if (!text || text.trim().length === 0) {
          throw new Error("TEXT_EMBEDDING requires non-empty text");
        }
        return await localEmbeddingManager.generateEmbedding(text);
      } catch (error) {
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          "Error in TEXT_EMBEDDING handler"
        );
        throw error instanceof Error
          ? error
          : new Error(`TEXT_EMBEDDING handler failed: ${String(error)}`);
      }
    },

    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      _runtime: IAgentRuntime,
      params: TokenizeTextParams
    ): Promise<number[]> => {
      try {
        const manager = localEmbeddingManager.getTokenizerManager();
        const config = localEmbeddingManager.getActiveModelConfig();
        return await manager.encode(params.prompt, config);
      } catch (error) {
        logger.error(
          error instanceof Error ? error : String(error),
          "Error in TEXT_TOKENIZER_ENCODE handler"
        );
        throw error;
      }
    },

    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      _runtime: IAgentRuntime,
      params: DetokenizeTextParams
    ): Promise<string> => {
      try {
        const manager = localEmbeddingManager.getTokenizerManager();
        const config = localEmbeddingManager.getActiveModelConfig();
        return await manager.decode(params.tokens, config);
      } catch (error) {
        logger.error(
          error instanceof Error ? error : String(error),
          "Error in TEXT_TOKENIZER_DECODE handler"
        );
        throw error;
      }
    },
  },

  tests: [
    {
      name: "local_embedding_plugin_tests",
      tests: [
        {
          name: "local_embedding_test_text_embedding",
          fn: async (runtime) => {
            logger.info("Starting TEXT_EMBEDDING test");
            const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
              text: "This is a test of the text embedding model.",
            });
            if (!Array.isArray(embedding)) throw new Error("Embedding is not an array");
            if (embedding.length === 0) throw new Error("Embedding array is empty");
            if (embedding.some((val) => typeof val !== "number")) {
              throw new Error("Embedding contains non-numeric values");
            }
            const nullEmbedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, null);
            if (!Array.isArray(nullEmbedding) || nullEmbedding.some((val) => val !== 0)) {
              throw new Error("Null input did not return zero vector");
            }
            logger.success("TEXT_EMBEDDING test completed successfully");
          },
        },
      ],
    },
  ],
};

// Legacy export alias for existing imports.
export const localAiPlugin = localEmbeddingPlugin;

export default localEmbeddingPlugin;
