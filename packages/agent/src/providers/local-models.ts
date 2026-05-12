/**
 * Local Models Provider
 *
 * Provides auto-download and local inference capabilities for:
 * - Vision models (BLIP, CLIP, etc.)
 * - LLM models (via Ollama or llama.cpp)
 * - TTS models (Coqui, XTTS, etc.)
 * - STT models (Whisper, etc.)
 *
 * Models are downloaded from HuggingFace and cached locally.
 * Uses @huggingface/hub for model downloads.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Security Guards
// ============================================================================

/** Guard against path traversal in filenames from external sources (e.g. HuggingFace). */
export function validateFilename(filename: string): void {
  if (
    filename.startsWith("/") ||
    filename.includes("\\") ||
    filename.split("/").some((seg) => seg === ".." || seg === "")
  ) {
    throw new Error(
      `Invalid filename "${filename}": path traversal or empty segments not allowed`,
    );
  }
}

// ============================================================================
// Types
// ============================================================================

export type ModelType = "vision" | "llm" | "tts" | "stt" | "embedding";

export interface LocalModelConfig {
  /** Model type */
  type: ModelType;
  /** HuggingFace model ID (e.g., "Salesforce/blip-image-captioning-large") */
  modelId: string;
  /** Display name */
  name: string;
  /** Model size in MB (approximate) */
  sizeInMb: number;
  /** Required files to download */
  requiredFiles?: string[];
  /** Whether to use ONNX format (faster inference) */
  useOnnx?: boolean;
  /** Ollama model name (for LLM models) */
  ollamaModel?: string;
}

export interface ModelDownloadProgress {
  modelId: string;
  file: string;
  downloaded: number;
  total: number;
  percent: number;
}

export interface LocalModelStatus {
  modelId: string;
  name: string;
  type: ModelType;
  downloaded: boolean;
  path?: string;
  sizeInMb: number;
}

// ============================================================================
// Model Registry
// ============================================================================

/**
 * Registry of recommended local models for each capability.
 * These are curated for good quality/size trade-offs.
 */
export const LOCAL_MODEL_REGISTRY: Record<ModelType, LocalModelConfig[]> = {
  vision: [
    {
      type: "vision",
      modelId: "Salesforce/blip-image-captioning-base",
      name: "BLIP Caption (Base)",
      sizeInMb: 990,
      useOnnx: true,
    },
    {
      type: "vision",
      modelId: "Salesforce/blip-image-captioning-large",
      name: "BLIP Caption (Large)",
      sizeInMb: 1900,
      useOnnx: true,
    },
    {
      type: "vision",
      modelId: "microsoft/Florence-2-base",
      name: "Florence-2 (Base)",
      sizeInMb: 460,
      useOnnx: false,
    },
    {
      type: "vision",
      modelId: "vikhyatk/moondream2",
      name: "Moondream2 (Tiny Vision LLM)",
      sizeInMb: 3600,
      ollamaModel: "moondream",
    },
  ],
  llm: [
    {
      type: "llm",
      modelId: "elizaos/eliza-1-0_8b",
      name: "Eliza-1 lite",
      sizeInMb: 512,
      requiredFiles: ["text/eliza-1-0_8b-32k.gguf"],
    },
    {
      type: "llm",
      modelId: "elizaos/eliza-1-2b",
      name: "Eliza-1 mobile",
      sizeInMb: 1229,
      requiredFiles: ["text/eliza-1-2b-32k.gguf"],
    },
    {
      type: "llm",
      modelId: "elizaos/eliza-1-9b",
      name: "Eliza-1 desktop",
      sizeInMb: 5529,
      requiredFiles: ["text/eliza-1-9b-64k.gguf"],
    },
    {
      type: "llm",
      modelId: "elizaos/eliza-1-27b",
      name: "Eliza-1 pro",
      sizeInMb: 17203,
      requiredFiles: ["text/eliza-1-27b-128k.gguf"],
    },
  ],
  tts: [
    {
      type: "tts",
      modelId: "parler-tts/parler-tts-mini-v1",
      name: "Parler TTS Mini",
      sizeInMb: 2400,
      useOnnx: false,
    },
    {
      type: "tts",
      modelId: "suno/bark-small",
      name: "Bark Small",
      sizeInMb: 1500,
      useOnnx: false,
    },
    {
      type: "tts",
      modelId: "microsoft/speecht5_tts",
      name: "SpeechT5 TTS",
      sizeInMb: 600,
      useOnnx: true,
    },
  ],
  stt: [
    {
      type: "stt",
      modelId: "openai/whisper-tiny",
      name: "Whisper Tiny",
      sizeInMb: 150,
      useOnnx: true,
    },
    {
      type: "stt",
      modelId: "openai/whisper-base",
      name: "Whisper Base",
      sizeInMb: 290,
      useOnnx: true,
    },
    {
      type: "stt",
      modelId: "openai/whisper-small",
      name: "Whisper Small",
      sizeInMb: 970,
      useOnnx: true,
    },
    {
      type: "stt",
      modelId: "openai/whisper-medium",
      name: "Whisper Medium",
      sizeInMb: 3100,
      useOnnx: true,
    },
  ],
  embedding: [
    {
      type: "embedding",
      modelId: "elizaos/eliza-1-0_8b",
      name: "Eliza-1 lite embeddings",
      sizeInMb: 512,
      requiredFiles: ["text/eliza-1-0_8b-32k.gguf"],
    },
  ],
};

// ============================================================================
// Local Model Manager
// ============================================================================

export class LocalModelManager {
  private cacheDir: string;
  private manifestPath: string;
  private manifest: Record<string, { downloadedAt: string; path: string }> = {};
  private ollamaUrl: string;
  private downloadLocks = new Map<string, Promise<string>>();

  constructor(options?: { cacheDir?: string; ollamaUrl?: string }) {
    this.cacheDir =
      options?.cacheDir ?? join(homedir(), ".cache", "eliza", "models");
    this.ollamaUrl = options?.ollamaUrl ?? "http://localhost:11434";
    this.manifestPath = join(this.cacheDir, "manifest.json");
    this.loadManifest();
  }

  private loadManifest(): void {
    if (existsSync(this.manifestPath)) {
      try {
        this.manifest = JSON.parse(readFileSync(this.manifestPath, "utf-8"));
      } catch {
        this.manifest = {};
      }
    }
  }

  private saveManifest(): void {
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2));
  }

  /**
   * Get the path where a model is (or would be) cached.
   */
  getModelPath(modelId: string): string {
    const safeName = modelId.replace(/[/\\:]/g, "_");
    return join(this.cacheDir, safeName);
  }

  /**
   * Check if a model is already downloaded.
   */
  isModelDownloaded(modelId: string): boolean {
    return !!this.manifest[modelId] && existsSync(this.manifest[modelId].path);
  }

  /**
   * Get status of all registered models.
   */
  getModelStatuses(type?: ModelType): LocalModelStatus[] {
    const models = type
      ? LOCAL_MODEL_REGISTRY[type]
      : Object.values(LOCAL_MODEL_REGISTRY).flat();

    return models.map((config) => ({
      modelId: config.modelId,
      name: config.name,
      type: config.type,
      downloaded: this.isModelDownloaded(config.modelId),
      path: this.manifest[config.modelId]?.path,
      sizeInMb: config.sizeInMb,
    }));
  }

  /**
   * Download a model from HuggingFace.
   */
  async downloadModel(
    modelId: string,
    onProgress?: (progress: ModelDownloadProgress) => void,
  ): Promise<string> {
    const existingDownload = this.downloadLocks.get(modelId);
    if (existingDownload) {
      return existingDownload;
    }

    const downloadPromise = this.downloadModelInner(modelId, onProgress);
    this.downloadLocks.set(modelId, downloadPromise);
    try {
      return await downloadPromise;
    } finally {
      this.downloadLocks.delete(modelId);
    }
  }

  private async downloadModelInner(
    modelId: string,
    onProgress?: (progress: ModelDownloadProgress) => void,
  ): Promise<string> {
    const config = Object.values(LOCAL_MODEL_REGISTRY)
      .flat()
      .find((model) => model.modelId === modelId);

    if (config?.ollamaModel) {
      return this.downloadOllamaModel(config.ollamaModel);
    }

    const modelPath = this.getModelPath(modelId);
    mkdirSync(modelPath, { recursive: true });

    console.log(`[local-models] Downloading ${modelId}...`);

    const apiUrl = `https://huggingface.co/api/models/${modelId}`;
    // @duplicate-component-audit-allow: Hugging Face model metadata download, not inference.
    const response = await fetch(apiUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch model info: ${response.statusText}`);
    }

    const modelInfo = (await response.json()) as {
      siblings?: Array<{ rfilename: string }>;
    };
    const files = modelInfo.siblings ?? [];

    const essentialPatterns = [
      /config\.json$/,
      /tokenizer.*\.json$/,
      /vocab.*\.json$/,
      /model.*\.(bin|safetensors|onnx)$/,
      /special_tokens_map\.json$/,
      /preprocessor_config\.json$/,
    ];

    const filesToDownload =
      config?.requiredFiles ??
      files
        .map((file) => file.rfilename)
        .filter((filename) =>
          essentialPatterns.some((pattern) => pattern.test(filename)),
        );

    const downloadList =
      filesToDownload.length > 0
        ? filesToDownload
        : files.map((file) => file.rfilename);

    let totalDownloaded = 0;
    const downloadedFiles = new Set<string>();
    for (const filename of downloadList) {
      validateFilename(filename);
      const fileUrl = `https://huggingface.co/${modelId}/resolve/main/${filename}`;
      const filePath = join(modelPath, filename);

      const fileDir = join(modelPath, ...filename.split("/").slice(0, -1));
      if (fileDir !== modelPath) {
        mkdirSync(fileDir, { recursive: true });
      }

      console.log(`[local-models] Downloading ${filename}...`);

      const fileResponse = await fetch(fileUrl);
      if (!fileResponse.ok) {
        console.warn(
          `[local-models] Failed to download ${filename}: ${fileResponse.statusText}`,
        );
        continue;
      }

      const arrayBuffer = await fileResponse.arrayBuffer();
      writeFileSync(filePath, Buffer.from(arrayBuffer));
      downloadedFiles.add(filename);

      totalDownloaded++;
      onProgress?.({
        modelId,
        file: filename,
        downloaded: totalDownloaded,
        total: downloadList.length,
        percent: (totalDownloaded / downloadList.length) * 100,
      });
    }

    const requiredWeightFiles = downloadList.filter((filename) =>
      /model.*\.(bin|safetensors|onnx)$/.test(filename),
    );
    const hasConfig = downloadedFiles.has("config.json");
    const hasWeights =
      requiredWeightFiles.length === 0 ||
      requiredWeightFiles.some((filename) => downloadedFiles.has(filename));
    if (!hasConfig || !hasWeights) {
      throw new Error(
        `Model download incomplete for ${modelId}: missing required config or weight files`,
      );
    }

    this.manifest[modelId] = {
      downloadedAt: new Date().toISOString(),
      path: modelPath,
    };
    this.saveManifest();

    console.log(`[local-models] Model ${modelId} downloaded to ${modelPath}`);
    return modelPath;
  }

  /**
   * Download a model via Ollama.
   */
  private async downloadOllamaModel(modelName: string): Promise<string> {
    console.log(`[local-models] Pulling Ollama model ${modelName}...`);

    // @duplicate-component-audit-allow: Ollama pull downloads weights; no prompt is generated.
    const response = await fetch(`${this.ollamaUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName, stream: false }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to pull Ollama model: ${text}`);
    }

    await response.json();

    const modelId = `ollama/${modelName}`;
    this.manifest[modelId] = {
      downloadedAt: new Date().toISOString(),
      path: `ollama:${modelName}`,
    };
    this.saveManifest();

    console.log(`[local-models] Ollama model ${modelName} pulled successfully`);
    return `ollama:${modelName}`;
  }

  /**
   * Get the recommended model for a given type.
   */
  getRecommendedModel(type: ModelType): LocalModelConfig | undefined {
    const models = LOCAL_MODEL_REGISTRY[type];
    return models?.[0];
  }

  /**
   * Ensure a model is available (download if needed).
   */
  async ensureModel(modelId: string): Promise<string> {
    if (this.isModelDownloaded(modelId)) {
      return this.manifest[modelId].path;
    }
    return this.downloadModel(modelId);
  }

  /**
   * List available Ollama models.
   */
  async listOllamaModels(): Promise<string[]> {
    try {
      // @duplicate-component-audit-allow: Ollama tags lists installed models; no generation.
      const response = await fetch(`${this.ollamaUrl}/api/tags`);
      if (!response.ok) return [];
      const data = (await response.json()) as {
        models?: Array<{ name: string }>;
      };
      return data.models?.map((model) => model.name) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Check if Ollama is running.
   */
  async isOllamaRunning(): Promise<boolean> {
    try {
      // @duplicate-component-audit-allow: Ollama tags health check; no generation.
      const response = await fetch(`${this.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Default instance
// ============================================================================

let defaultManager: LocalModelManager | null = null;

export function getLocalModelManager(options?: {
  cacheDir?: string;
  ollamaUrl?: string;
}): LocalModelManager {
  if (!defaultManager) {
    defaultManager = new LocalModelManager(options);
  }
  return defaultManager;
}

// ============================================================================
// Convenience functions
// ============================================================================

/**
 * Download the recommended model for a given type.
 */
export async function downloadRecommendedModel(
  type: ModelType,
  onProgress?: (progress: ModelDownloadProgress) => void,
): Promise<string> {
  const manager = getLocalModelManager();
  const config = manager.getRecommendedModel(type);
  if (!config) {
    throw new Error(`No recommended model for type: ${type}`);
  }
  return manager.downloadModel(config.modelId, onProgress);
}

/**
 * Get status of all local models.
 */
export function getLocalModelStatuses(type?: ModelType): LocalModelStatus[] {
  return getLocalModelManager().getModelStatuses(type);
}

/**
 * Ensure a model is available for use.
 */
export async function ensureLocalModel(modelId: string): Promise<string> {
  return getLocalModelManager().ensureModel(modelId);
}
