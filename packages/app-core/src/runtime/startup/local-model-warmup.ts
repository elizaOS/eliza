/**
 * Coordinates optional local embedding and voice model warmup around runtime
 * readiness. Expensive model work is serialized per process and remains an
 * optimization; the model handlers retain ownership of first-use failures.
 */
import { configureLocalEmbeddingPlugin, loadElizaConfig } from "@elizaos/agent";
import {
  type AgentRuntime,
  isTruthyEnvValue,
  logger,
  ModelType,
  type Plugin,
} from "@elizaos/core";
import { formatError, isMobilePlatform } from "@elizaos/shared";
import {
  type EmbeddingWarmupPhase,
  updateStartupEmbeddingProgress,
} from "../startup-overlay.js";
import { shouldWarmupVoice, warmVoiceModels } from "../voice-warmup.js";

export type EmbeddingProgressCallback = (
  phase: EmbeddingWarmupPhase,
  detail?: string,
) => void;

let localInferenceRuntime:
  | typeof import("@elizaos/plugin-local-inference/runtime")
  | undefined;
let warmupInFlight: Promise<void> | null = null;

async function getLocalInferenceRuntime() {
  localInferenceRuntime ??= await import(
    "@elizaos/plugin-local-inference/runtime"
  );
  return localInferenceRuntime;
}

function isLocalEmbeddingWarmupDeferredByEnv(): boolean {
  const raw =
    process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

function startLocalEmbeddingWarmup(
  onProgress?: EmbeddingProgressCallback,
): void {
  void warmupEmbeddingModel(onProgress);
}

/** Starts eager warmup only when the operator has disabled default deferral. */
export function prepareLocalEmbeddingWarmup(
  onProgress?: EmbeddingProgressCallback,
): void {
  if (isLocalEmbeddingWarmupDeferredByEnv()) {
    logger.info("[eliza] Deferring local embedding warmup until runtime ready");
    return;
  }
  startLocalEmbeddingWarmup(onProgress);
}

/** Starts the default deferred warmup and reports whether policy allowed it. */
export function startDeferredLocalEmbeddingWarmup(
  onProgress?: EmbeddingProgressCallback,
): boolean {
  if (!isLocalEmbeddingWarmupDeferredByEnv()) return false;
  logger.info("[eliza] Starting deferred local embedding warmup");
  startLocalEmbeddingWarmup(onProgress);
  return true;
}

/** Sets the SQL provisioning width without overriding an explicit model width. */
export function ensureDefaultEmbeddingDimension(): void {
  process.env.EMBEDDING_DIMENSION ??= "384";
}

async function warmupEmbeddingModel(
  onProgress?: EmbeddingProgressCallback,
): Promise<void> {
  if (warmupInFlight) return warmupInFlight;
  warmupInFlight = warmupEmbeddingModelImpl(onProgress).finally(() => {
    warmupInFlight = null;
  });
  return warmupInFlight;
}

async function warmupEmbeddingModelImpl(
  onProgress?: EmbeddingProgressCallback,
): Promise<void> {
  if (isMobilePlatform()) {
    logger.info(
      "[eliza] Skipping local embedding warmup — running on mobile (ELIZA_PLATFORM=android|ios)",
    );
    return;
  }

  const localInference = await getLocalInferenceRuntime();
  if (!localInference.shouldWarmupLocalEmbeddingModel()) {
    logger.info(
      "[eliza] Skipping local embedding (GGUF) warmup — not needed for this configuration (e.g. Eliza Cloud embeddings, or local embeddings disabled).",
    );
    return;
  }

  const config = loadElizaConfig();
  await configureLocalEmbeddingPlugin({} as Plugin, config);

  const preset = localInference.detectEmbeddingPreset();
  const modelsDir = process.env.MODELS_DIR ?? localInference.DEFAULT_MODELS_DIR;
  let model = process.env.LOCAL_EMBEDDING_MODEL?.trim() || preset.model;
  let modelRepo =
    process.env.LOCAL_EMBEDDING_MODEL_REPO?.trim() || preset.modelRepo;

  if (
    !localInference.isEmbeddingWarmupReuseDisabled() &&
    !localInference.embeddingGgufFilePresent(modelsDir, model)
  ) {
    const reuse =
      localInference.findExistingEmbeddingModelForWarmupReuse(modelsDir);
    if (reuse) {
      logger.info(
        `[eliza] Embedding warmup: configured file "${model}" not found in MODELS_DIR — reusing existing ${reuse.model} to avoid a large re-download. ` +
          "Set LOCAL_EMBEDDING_MODEL or ELIZA_EMBEDDING_WARMUP_NO_REUSE=1 to force the configured model.",
      );
      process.env.LOCAL_EMBEDDING_MODEL = reuse.model;
      process.env.LOCAL_EMBEDDING_MODEL_REPO = reuse.modelRepo;
      process.env.LOCAL_EMBEDDING_DIMENSIONS = String(reuse.dimensions);
      process.env.LOCAL_EMBEDDING_CONTEXT_SIZE = String(reuse.contextSize);
      process.env.LOCAL_EMBEDDING_GPU_LAYERS = reuse.gpuLayers;
      process.env.LOCAL_EMBEDDING_USE_MMAP =
        reuse.gpuLayers === "auto" ? "false" : "true";
      model = reuse.model;
      modelRepo = reuse.modelRepo;
    }
  }

  logger.info(
    `[eliza] Local embedding warmup: ${model} (hardware tier preset: ${preset.label}). ` +
      "This file is for TEXT_EMBEDDING / memory only (not your conversation model).",
  );

  const progressCallback: EmbeddingProgressCallback = (phase, detail) => {
    updateStartupEmbeddingProgress(phase, detail);
    if (phase === "downloading") {
      logger.info(`[eliza] Embedding model: ${detail ?? "downloading..."}`);
    } else if (phase === "loading") {
      logger.info(`[eliza] Embedding model: loading ${detail ?? ""}`);
    } else if (phase === "ready") {
      logger.info(`[eliza] Embedding model: ready (${detail ?? ""})`);
    }
    onProgress?.(phase, detail);
  };

  try {
    await localInference.ensureModel(
      modelsDir,
      modelRepo,
      model,
      false,
      progressCallback,
    );
  } catch (error) {
    // error-policy:J4 warmup is optional and the model handler exposes the
    // actual load failure on first use, where it can retry the download.
    logger.warn(
      `[eliza] Embedding model warmup failed (will retry on first use): ${formatError(error)}`,
    );
  }
}

function isExplicitDesktopCloudOnlyRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const runtimeMode = env.ELIZA_DESKTOP_RUNTIME_MODE?.trim().toLowerCase();
  return (
    runtimeMode === "cloud" ||
    runtimeMode === "elizacloud" ||
    isTruthyEnvValue(env.ELIZA_DESKTOP_CLOUD_ONLY)
  );
}

/** Warms local voice handlers after the runtime is ready when policy permits. */
export async function startDeferredVoiceWarmup(
  runtime: AgentRuntime,
): Promise<void> {
  if (
    !shouldWarmupVoice({
      enabled: isTruthyEnvValue(process.env.ELIZA_ENABLE_VOICE_WARMUP),
      mobile: isMobilePlatform(),
      skipEnv: isTruthyEnvValue(process.env.ELIZA_SKIP_LOCAL_VOICE_WARMUP),
      cloudOnly: isExplicitDesktopCloudOnlyRuntime(),
      hotReload: isTruthyEnvValue(process.env.ELIZA_DEV_IS_HOT_RELOAD),
    })
  ) {
    return;
  }
  logger.info("[eliza] Starting deferred voice warmup");
  await warmVoiceModels(
    runtime as Parameters<typeof warmVoiceModels>[0],
    {
      ttsType: ModelType.TEXT_TO_SPEECH,
      transcriptionType: ModelType.TRANSCRIPTION,
    },
    {
      info: (message: string) => logger.info(message),
      warn: (message: string) => logger.warn(message),
    },
  );
}
