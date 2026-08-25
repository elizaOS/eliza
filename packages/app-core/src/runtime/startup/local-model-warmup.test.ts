/**
 * Unit coverage for local embedding and voice warmup policy around runtime
 * ready. Drives the real module; local-inference download/load and Eliza
 * config I/O are stubbed so the suite does not fetch GGUFs or read eliza.json.
 */
import type { AgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { formatError } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStartupEmbeddingAugmentation } from "../startup-overlay.ts";
import type { EmbeddingProgressCallback } from "./local-model-warmup.ts";
import {
  ensureDefaultEmbeddingDimension,
  prepareLocalEmbeddingWarmup,
  startDeferredLocalEmbeddingWarmup,
  startDeferredVoiceWarmup,
} from "./local-model-warmup.ts";

const DEFAULT_MODELS_DIR = "/mock-models";
const PRESET = {
  label: "Efficient (CPU)",
  model: "gte-small_fp16.gguf",
  modelRepo: "ChristianAzinn/gte-small-gguf",
};
const CONFIG = { character: { name: "Eliza" } };

const mocks = vi.hoisted(() => ({
  configureLocalEmbeddingPlugin: vi.fn(),
  loadElizaConfig: vi.fn(),
  shouldWarmupLocalEmbeddingModel: vi.fn(),
  detectEmbeddingPreset: vi.fn(),
  isEmbeddingWarmupReuseDisabled: vi.fn(),
  embeddingGgufFilePresent: vi.fn(),
  findExistingEmbeddingModelForWarmupReuse: vi.fn(),
  ensureModel: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  configureLocalEmbeddingPlugin: mocks.configureLocalEmbeddingPlugin,
  loadElizaConfig: mocks.loadElizaConfig,
}));

vi.mock("@elizaos/plugin-local-inference/runtime", () => ({
  DEFAULT_MODELS_DIR,
  shouldWarmupLocalEmbeddingModel: mocks.shouldWarmupLocalEmbeddingModel,
  detectEmbeddingPreset: mocks.detectEmbeddingPreset,
  isEmbeddingWarmupReuseDisabled: mocks.isEmbeddingWarmupReuseDisabled,
  embeddingGgufFilePresent: mocks.embeddingGgufFilePresent,
  findExistingEmbeddingModelForWarmupReuse:
    mocks.findExistingEmbeddingModelForWarmupReuse,
  ensureModel: mocks.ensureModel,
}));

const ENV_KEYS = [
  "ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP",
  "EMBEDDING_DIMENSION",
  "ELIZA_PLATFORM",
  "MODELS_DIR",
  "LOCAL_EMBEDDING_MODEL",
  "LOCAL_EMBEDDING_MODEL_REPO",
  "LOCAL_EMBEDDING_DIMENSIONS",
  "LOCAL_EMBEDDING_CONTEXT_SIZE",
  "LOCAL_EMBEDDING_GPU_LAYERS",
  "LOCAL_EMBEDDING_USE_MMAP",
  "ELIZA_EMBEDDING_WARMUP_NO_REUSE",
  "ELIZA_ENABLE_VOICE_WARMUP",
  "ELIZA_SKIP_LOCAL_VOICE_WARMUP",
  "ELIZA_DESKTOP_RUNTIME_MODE",
  "ELIZA_DESKTOP_CLOUD_ONLY",
  "ELIZA_DEV_IS_HOT_RELOAD",
] as const;

let savedEnv: Record<string, string | undefined>;
let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function snapshotEnv(): void {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function runtimeStub(useModel: unknown = async () => undefined): AgentRuntime {
  return { useModel } as unknown as AgentRuntime;
}

async function drainEmbeddingWarmup(): Promise<void> {
  const pending = mocks.ensureModel.mock.results
    .filter((result) => result.type === "return")
    .map((result) => result.value);
  await Promise.allSettled(pending);
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  snapshotEnv();
  infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
  warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  mocks.configureLocalEmbeddingPlugin.mockReset();
  mocks.loadElizaConfig.mockReset();
  mocks.shouldWarmupLocalEmbeddingModel.mockReset();
  mocks.detectEmbeddingPreset.mockReset();
  mocks.isEmbeddingWarmupReuseDisabled.mockReset();
  mocks.embeddingGgufFilePresent.mockReset();
  mocks.findExistingEmbeddingModelForWarmupReuse.mockReset();
  mocks.ensureModel.mockReset();
  mocks.configureLocalEmbeddingPlugin.mockResolvedValue(undefined);
  mocks.loadElizaConfig.mockReturnValue(CONFIG);
  mocks.shouldWarmupLocalEmbeddingModel.mockReturnValue(true);
  mocks.detectEmbeddingPreset.mockReturnValue(PRESET);
  mocks.isEmbeddingWarmupReuseDisabled.mockReturnValue(false);
  mocks.embeddingGgufFilePresent.mockReturnValue(true);
  mocks.findExistingEmbeddingModelForWarmupReuse.mockReturnValue(null);
  mocks.ensureModel.mockResolvedValue(`${DEFAULT_MODELS_DIR}/${PRESET.model}`);
});

afterEach(async () => {
  await drainEmbeddingWarmup();
  restoreEnv();
  infoSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("ensureDefaultEmbeddingDimension", () => {
  it("writes 384 only when EMBEDDING_DIMENSION is unset", () => {
    ensureDefaultEmbeddingDimension();
    expect(process.env.EMBEDDING_DIMENSION).toBe("384");
  });

  it("does not override an explicit width, including empty string", () => {
    process.env.EMBEDDING_DIMENSION = "768";
    ensureDefaultEmbeddingDimension();
    expect(process.env.EMBEDDING_DIMENSION).toBe("768");

    process.env.EMBEDDING_DIMENSION = "";
    ensureDefaultEmbeddingDimension();
    expect(process.env.EMBEDDING_DIMENSION).toBe("");

    process.env.EMBEDDING_DIMENSION = "0";
    ensureDefaultEmbeddingDimension();
    expect(process.env.EMBEDDING_DIMENSION).toBe("0");
  });
});

describe("prepareLocalEmbeddingWarmup", () => {
  it("defers by default and when the env is any non-disable value", () => {
    prepareLocalEmbeddingWarmup();
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Deferring local embedding warmup until runtime ready",
    );
    expect(mocks.shouldWarmupLocalEmbeddingModel).not.toHaveBeenCalled();

    infoSpy.mockClear();
    process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP = "true";
    prepareLocalEmbeddingWarmup();
    process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP = "1";
    prepareLocalEmbeddingWarmup();
    process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP = "yes";
    prepareLocalEmbeddingWarmup();
    process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP = "";
    prepareLocalEmbeddingWarmup();
    expect(mocks.ensureModel).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(4);
  });

  it("starts eager warmup when deferral is disabled, including mixed-case and padding", async () => {
    for (const value of ["0", "false", "no", "off", " FALSE ", "Off"]) {
      mocks.ensureModel.mockClear();
      process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP = value;
      prepareLocalEmbeddingWarmup();
      await vi.waitFor(() => {
        expect(mocks.ensureModel).toHaveBeenCalledOnce();
      });
      await drainEmbeddingWarmup();
    }
  });
});

describe("startDeferredLocalEmbeddingWarmup", () => {
  it("returns false and does not start when deferral is disabled", () => {
    for (const value of ["0", "false", "no", "off", " FALSE "]) {
      process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP = value;
      expect(startDeferredLocalEmbeddingWarmup()).toBe(false);
    }
    expect(mocks.ensureModel).not.toHaveBeenCalled();
  });

  it("returns true and starts warmup when deferral is the default", async () => {
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Starting deferred local embedding warmup",
    );
    await vi.waitFor(() => {
      expect(mocks.ensureModel).toHaveBeenCalledOnce();
    });
  });
});

describe("embedding warmup skip paths", () => {
  it("skips on android and ios without touching local inference", async () => {
    process.env.ELIZA_PLATFORM = "android";
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    await vi.waitFor(() => {
      expect(infoSpy).toHaveBeenCalledWith(
        "[eliza] Skipping local embedding warmup — running on mobile (ELIZA_PLATFORM=android|ios)",
      );
    });
    expect(mocks.shouldWarmupLocalEmbeddingModel).not.toHaveBeenCalled();
    expect(mocks.ensureModel).not.toHaveBeenCalled();

    process.env.ELIZA_PLATFORM = "ios";
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    await drainEmbeddingWarmup();
    expect(mocks.ensureModel).not.toHaveBeenCalled();
  });

  it("skips when local inference reports warmup is not needed", async () => {
    mocks.shouldWarmupLocalEmbeddingModel.mockReturnValue(false);
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    await vi.waitFor(() => {
      expect(infoSpy).toHaveBeenCalledWith(
        "[eliza] Skipping local embedding (GGUF) warmup — not needed for this configuration (e.g. Eliza Cloud embeddings, or local embeddings disabled).",
      );
    });
    expect(mocks.loadElizaConfig).not.toHaveBeenCalled();
    expect(mocks.ensureModel).not.toHaveBeenCalled();
  });
});

describe("embedding warmup model selection", () => {
  it("uses MODELS_DIR, env model, and env repo when they are non-blank", async () => {
    process.env.MODELS_DIR = "/custom-models";
    process.env.LOCAL_EMBEDDING_MODEL = "  custom.gguf  ";
    process.env.LOCAL_EMBEDDING_MODEL_REPO = "  owner/custom  ";
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.ensureModel).toHaveBeenCalledOnce();
    });
    expect(mocks.loadElizaConfig).toHaveBeenCalledOnce();
    expect(mocks.configureLocalEmbeddingPlugin).toHaveBeenCalledWith(
      {},
      CONFIG,
    );
    expect(mocks.embeddingGgufFilePresent).toHaveBeenCalledWith(
      "/custom-models",
      "custom.gguf",
    );
    expect(mocks.ensureModel.mock.calls[0]?.slice(0, 4)).toEqual([
      "/custom-models",
      "owner/custom",
      "custom.gguf",
      false,
    ]);
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Local embedding warmup: custom.gguf (hardware tier preset: Efficient (CPU)). This file is for TEXT_EMBEDDING / memory only (not your conversation model).",
    );
  });

  it("falls back to the preset and DEFAULT_MODELS_DIR when env model/repo are blank", async () => {
    process.env.LOCAL_EMBEDDING_MODEL = "   ";
    process.env.LOCAL_EMBEDDING_MODEL_REPO = "";
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.ensureModel).toHaveBeenCalledOnce();
    });
    expect(mocks.ensureModel.mock.calls[0]?.slice(0, 4)).toEqual([
      DEFAULT_MODELS_DIR,
      PRESET.modelRepo,
      PRESET.model,
      false,
    ]);
  });

  it("reuses an existing on-disk model when the configured file is missing", async () => {
    mocks.embeddingGgufFilePresent.mockReturnValue(false);
    mocks.findExistingEmbeddingModelForWarmupReuse.mockReturnValue({
      model: "reused.gguf",
      modelRepo: "owner/reused",
      dimensions: 384,
      contextSize: 512,
      gpuLayers: "auto",
    });
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.ensureModel).toHaveBeenCalledOnce();
    });
    expect(process.env.LOCAL_EMBEDDING_MODEL).toBe("reused.gguf");
    expect(process.env.LOCAL_EMBEDDING_MODEL_REPO).toBe("owner/reused");
    expect(process.env.LOCAL_EMBEDDING_DIMENSIONS).toBe("384");
    expect(process.env.LOCAL_EMBEDDING_CONTEXT_SIZE).toBe("512");
    expect(process.env.LOCAL_EMBEDDING_GPU_LAYERS).toBe("auto");
    expect(process.env.LOCAL_EMBEDDING_USE_MMAP).toBe("false");
    expect(mocks.ensureModel.mock.calls[0]?.slice(0, 4)).toEqual([
      DEFAULT_MODELS_DIR,
      "owner/reused",
      "reused.gguf",
      false,
    ]);
  });

  it("sets mmap true when the reused candidate is not auto GPU layers", async () => {
    mocks.embeddingGgufFilePresent.mockReturnValue(false);
    mocks.findExistingEmbeddingModelForWarmupReuse.mockReturnValue({
      model: "reused-cpu.gguf",
      modelRepo: "owner/cpu",
      dimensions: 384,
      contextSize: 256,
      gpuLayers: "0",
    });
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.ensureModel).toHaveBeenCalledOnce();
    });
    expect(process.env.LOCAL_EMBEDDING_USE_MMAP).toBe("true");
    expect(process.env.LOCAL_EMBEDDING_GPU_LAYERS).toBe("0");
  });

  it("does not reuse when reuse is disabled or no candidate exists", async () => {
    process.env.LOCAL_EMBEDDING_MODEL = "configured.gguf";
    mocks.embeddingGgufFilePresent.mockReturnValue(false);
    mocks.isEmbeddingWarmupReuseDisabled.mockReturnValue(true);
    mocks.findExistingEmbeddingModelForWarmupReuse.mockReturnValue({
      model: "reused.gguf",
      modelRepo: "owner/reused",
      dimensions: 384,
      contextSize: 512,
      gpuLayers: "auto",
    });
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.ensureModel).toHaveBeenCalledOnce();
    });
    expect(
      mocks.findExistingEmbeddingModelForWarmupReuse,
    ).not.toHaveBeenCalled();
    expect(mocks.ensureModel.mock.calls[0]?.[2]).toBe("configured.gguf");
    expect(process.env.LOCAL_EMBEDDING_MODEL).toBe("configured.gguf");

    await drainEmbeddingWarmup();
    mocks.ensureModel.mockClear();
    mocks.isEmbeddingWarmupReuseDisabled.mockReturnValue(false);
    mocks.findExistingEmbeddingModelForWarmupReuse.mockReturnValue(null);
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.ensureModel).toHaveBeenCalledOnce();
    });
    expect(mocks.ensureModel.mock.calls[0]?.[2]).toBe("configured.gguf");
  });
});

describe("embedding warmup progress and failure", () => {
  it("forwards progress into the overlay, operator callback, and phase logs", async () => {
    const onProgress = vi.fn();
    expect(startDeferredLocalEmbeddingWarmup(onProgress)).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.ensureModel).toHaveBeenCalledOnce();
    });
    const progress = mocks.ensureModel.mock.calls[0]?.[4] as
      | EmbeddingProgressCallback
      | undefined;
    expect(typeof progress).toBe("function");
    if (!progress) throw new Error("expected ensureModel progress callback");

    const beforeChecking = infoSpy.mock.calls.length;
    progress("checking", "gte-small_fp16.gguf");
    expect(infoSpy.mock.calls.length).toBe(beforeChecking);
    expect(onProgress).toHaveBeenCalledWith("checking", "gte-small_fp16.gguf");
    expect(getStartupEmbeddingAugmentation()).toEqual(
      expect.objectContaining({
        embeddingPhase: "checking",
        embeddingDetail: "gte-small_fp16.gguf",
      }),
    );

    progress("downloading");
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Embedding model: downloading...",
    );
    progress("downloading", "45% of 95 MB");
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Embedding model: 45% of 95 MB",
    );
    expect(getStartupEmbeddingAugmentation()).toEqual(
      expect.objectContaining({
        embeddingPhase: "downloading",
        embeddingDetail: "45% of 95 MB",
        embeddingProgressPct: 45,
      }),
    );

    progress("loading");
    expect(infoSpy).toHaveBeenCalledWith("[eliza] Embedding model: loading ");
    progress("loading", "gte-small_fp16.gguf");
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Embedding model: loading gte-small_fp16.gguf",
    );

    progress("ready");
    expect(infoSpy).toHaveBeenCalledWith("[eliza] Embedding model: ready ()");
    expect(getStartupEmbeddingAugmentation()).toBeNull();
    progress("ready", "model already downloaded");
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Embedding model: ready (model already downloaded)",
    );
    expect(onProgress).toHaveBeenCalledWith(
      "ready",
      "model already downloaded",
    );
  });

  it("swallows ensureModel failure and logs a first-use retry warning", async () => {
    const failure = new Error("download failed");
    mocks.ensureModel.mockRejectedValue(failure);
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        `[eliza] Embedding model warmup failed (will retry on first use): ${formatError(failure)}`,
      );
    });
    await expect(drainEmbeddingWarmup()).resolves.toBeUndefined();
  });
});

describe("embedding warmup in-flight serialization", () => {
  it("shares one in-flight ensureModel and allows a later run after it settles", async () => {
    let release!: (value: string) => void;
    mocks.ensureModel.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.ensureModel).toHaveBeenCalledOnce();
    });
    release(`${DEFAULT_MODELS_DIR}/${PRESET.model}`);
    await drainEmbeddingWarmup();

    mocks.ensureModel.mockResolvedValue(
      `${DEFAULT_MODELS_DIR}/${PRESET.model}`,
    );
    expect(startDeferredLocalEmbeddingWarmup()).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.ensureModel).toHaveBeenCalledTimes(2);
    });
  });
});

describe("startDeferredVoiceWarmup", () => {
  it("does not warm by default or when any skip gate is set", async () => {
    const useModel = vi.fn(async () => undefined);
    const runtime = runtimeStub(useModel);

    await startDeferredVoiceWarmup(runtime);
    process.env.ELIZA_ENABLE_VOICE_WARMUP = "1";
    process.env.ELIZA_PLATFORM = "android";
    await startDeferredVoiceWarmup(runtime);
    delete process.env.ELIZA_PLATFORM;
    process.env.ELIZA_SKIP_LOCAL_VOICE_WARMUP = "1";
    await startDeferredVoiceWarmup(runtime);
    delete process.env.ELIZA_SKIP_LOCAL_VOICE_WARMUP;
    process.env.ELIZA_DESKTOP_RUNTIME_MODE = "cloud";
    await startDeferredVoiceWarmup(runtime);
    process.env.ELIZA_DESKTOP_RUNTIME_MODE = " ELIZACLOUD ";
    await startDeferredVoiceWarmup(runtime);
    delete process.env.ELIZA_DESKTOP_RUNTIME_MODE;
    process.env.ELIZA_DESKTOP_CLOUD_ONLY = "true";
    await startDeferredVoiceWarmup(runtime);
    delete process.env.ELIZA_DESKTOP_CLOUD_ONLY;
    process.env.ELIZA_DEV_IS_HOT_RELOAD = "1";
    await startDeferredVoiceWarmup(runtime);

    expect(useModel).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalledWith(
      "[eliza] Starting deferred voice warmup",
    );
  });

  it("warms TTS then transcription when explicitly enabled on desktop", async () => {
    process.env.ELIZA_ENABLE_VOICE_WARMUP = "1";
    process.env.ELIZA_DESKTOP_RUNTIME_MODE = "local";
    const calls: unknown[] = [];
    const useModel = vi.fn(async (modelType: unknown) => {
      calls.push(modelType);
      return undefined;
    });
    await startDeferredVoiceWarmup(runtimeStub(useModel));
    expect(infoSpy).toHaveBeenCalledWith(
      "[eliza] Starting deferred voice warmup",
    );
    expect(calls).toEqual([ModelType.TEXT_TO_SPEECH, ModelType.TRANSCRIPTION]);
    expect(infoSpy).toHaveBeenCalledWith("[eliza] Voice TTS model: ready");
    expect(infoSpy).toHaveBeenCalledWith("[eliza] Voice STT model: ready");
  });
});
