/**
 * Unit tests for the pure bootstrap helpers — load-arg building, generate
 * token-budget resolution, embedding gating, bundled-model resolution, and
 * memory-eviction thresholds. No native library or model is loaded; the
 * helpers run against real filesystem tempdirs and env overrides, so the
 * assertions cover the deterministic JS logic rather than the FFI boundary.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  firstSentenceEndIndex,
  resolveAospGenerateTokenBudget,
} from "../src/aosp-llama-paths";
import {
  aospAsrAssetsPresent,
  buildAospLoadModelArgs,
  buildGenerateArgsFromParams,
  disabledAospEmbeddingVector,
  flattenGenerateTextParamsForAospPrompt,
  isAospLocalEmbeddingEnabled,
  makeAospTextToSpeechHandler,
  parseMemAvailableMb,
  readAssignedBundledModels,
  removeAospGeneratedStagingDir,
  shouldEvictChatForAvailMb,
  VOICE_COLOAD_KEEP_AVAIL_MB,
} from "../src/aosp-local-inference-bootstrap";

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("flattenGenerateTextParamsForAospPrompt", () => {
  it("passes through a legacy prompt unchanged", () => {
    expect(
      flattenGenerateTextParamsForAospPrompt({
        prompt: "already flattened",
        messages: [{ role: "user", content: "ignored" }],
      }),
    ).toBe("already flattened");
  });

  it("renders v5 chat messages into a non-empty model prompt", () => {
    expect(
      flattenGenerateTextParamsForAospPrompt({
        maxTokens: 1024,
        messages: [
          { role: "system", content: "Stage 1 instructions" },
          { role: "user", content: "Say pixel bundle ok." },
        ],
      }),
    ).toBe(
      [
        "<start_of_turn>system\nStage 1 instructions<end_of_turn>",
        "<start_of_turn>user\nSay pixel bundle ok.<end_of_turn>",
        "<start_of_turn>model\n",
      ].join("\n"),
    );
  });

  it("prepends params.system when messages do not include a system message", () => {
    expect(
      flattenGenerateTextParamsForAospPrompt({
        system: "You are Eliza.",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toBe(
      [
        "<start_of_turn>system\nYou are Eliza.<end_of_turn>",
        "<start_of_turn>user\nhello<end_of_turn>",
        "<start_of_turn>model\n",
      ].join("\n"),
    );
  });

  it("falls back to prompt segments for segment-only calls", () => {
    expect(
      flattenGenerateTextParamsForAospPrompt({
        promptSegments: [
          { content: "prefix ", stable: true },
          { content: "tail", stable: false },
        ],
      }),
    ).toBe("prefix tail");
  });
});

describe("buildGenerateArgsFromParams", () => {
  it("preserves Stage-1 grammar and cancellation controls for the native loader", () => {
    const ctrl = new AbortController();
    expect(
      buildGenerateArgsFromParams({
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 384,
        temperature: 0,
        grammar: 'root ::= "ok"',
        signal: ctrl.signal,
      }),
    ).toEqual({
      prompt: "<start_of_turn>user\nhello<end_of_turn>\n<start_of_turn>model\n",
      maxTokens: 384,
      temperature: 0,
      grammar: 'root ::= "ok"',
      signal: ctrl.signal,
      stopSequences: ["<end_of_turn>", "<start_of_turn>"],
    });
  });

  it("forwards streaming callbacks only when the caller asks for streaming", () => {
    const chunks: string[] = [];
    const args = buildGenerateArgsFromParams({
      prompt: "hello",
      stream: true,
      onStreamChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    args.onTextChunk?.("hi");

    expect(chunks).toEqual(["hi"]);
    expect(
      buildGenerateArgsFromParams({
        prompt: "hello",
        onStreamChunk: () => {
          throw new Error("should not be wired without stream=true");
        },
      }).onTextChunk,
    ).toBeUndefined();
  });

  it("forwards Android-local first-sentence stop hints", () => {
    expect(
      buildGenerateArgsFromParams({
        prompt: "hello",
        stream: true,
        providerOptions: {
          androidLocal: {
            stopOnFirstSentence: true,
            minFirstSentenceChars: 10,
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        stopOnFirstSentence: true,
        minFirstSentenceChars: 10,
      }),
    );
  });
});

describe("buildAospLoadModelArgs", () => {
  it("leaves bundled MTP disabled by default on stock Android", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-mtp-model-"));
    const textDir = path.join(root, "eliza-1-2b.bundle", "text");
    const mtpDir = path.join(root, "eliza-1-2b.bundle", "mtp");
    mkdirSync(textDir, { recursive: true });
    mkdirSync(mtpDir, { recursive: true });
    const chat = path.join(textDir, "eliza-1-2b-32k.gguf");
    const drafter = path.join(mtpDir, "drafter-2b.gguf");
    writeFileSync(chat, "chat");
    writeFileSync(drafter, "draft");

    withEnv(
      {
        ELIZA_MOBILE_PLATFORM: "android",
        ELIZA_MTP: undefined,
        ELIZA_MTP_SERVER_SPAWN: undefined,
      },
      () => {
        expect(buildAospLoadModelArgs("chat", chat)).toEqual(
          expect.objectContaining({
            modelPath: chat,
            draftModelPath: undefined,
          }),
        );
      },
    );
  });

  it("auto-pairs a publish-eligible bundled MTP drafter on stock Android", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-mtp-auto-"));
    const textDir = path.join(root, "eliza-1-2b.bundle", "text");
    const mtpDir = path.join(root, "eliza-1-2b.bundle", "mtp");
    mkdirSync(textDir, { recursive: true });
    mkdirSync(mtpDir, { recursive: true });
    const chat = path.join(textDir, "eliza-1-2b-32k.gguf");
    const drafter = path.join(mtpDir, "drafter-2b.gguf");
    writeFileSync(chat, "chat");
    writeFileSync(drafter, "draft");
    writeFileSync(
      path.join(mtpDir, "target-meta.json"),
      JSON.stringify({
        publishEligible: true,
        targetText: {
          sha256: "a".repeat(64),
          sizeBytes: 556_982_432,
          finalElizaWeights: true,
        },
        drafter: {
          sha256: "b".repeat(64),
          sizeBytes: 237_637_024,
          finalElizaWeights: true,
        },
        validation: {
          checks: {
            architectureLoadable: { pass: true },
            vocabMatch: { pass: true },
            tokenizerMetadataMatch: { pass: true },
            drafterSmaller: { pass: true },
          },
        },
      }),
    );

    withEnv(
      {
        ELIZA_MOBILE_PLATFORM: "android",
        ELIZA_MTP: undefined,
        ELIZA_MTP_SERVER_SPAWN: undefined,
      },
      () => {
        expect(buildAospLoadModelArgs("chat", chat)).toEqual(
          expect.objectContaining({
            modelPath: chat,
            draftModelPath: drafter,
            draftContextSize: 2048,
            draftMin: 1,
            draftMax: 16,
          }),
        );
      },
    );
  });

  it("does not auto-pair candidate MTP metadata on stock Android", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-mtp-candidate-"));
    const textDir = path.join(root, "eliza-1-2b.bundle", "text");
    const mtpDir = path.join(root, "eliza-1-2b.bundle", "mtp");
    mkdirSync(textDir, { recursive: true });
    mkdirSync(mtpDir, { recursive: true });
    const chat = path.join(textDir, "eliza-1-2b-32k.gguf");
    const drafter = path.join(mtpDir, "drafter-2b.gguf");
    writeFileSync(chat, "chat");
    writeFileSync(drafter, "draft");
    writeFileSync(
      path.join(mtpDir, "target-meta.json"),
      JSON.stringify({
        publishEligible: false,
        targetText: { sha256: "a".repeat(64), sizeBytes: 1_270_808_512 },
        drafter: { sha256: "b".repeat(64), sizeBytes: 811_843_840 },
      }),
    );

    withEnv(
      {
        ELIZA_MOBILE_PLATFORM: "android",
        ELIZA_MTP: undefined,
        ELIZA_MTP_SERVER_SPAWN: undefined,
      },
      () => {
        expect(buildAospLoadModelArgs("chat", chat)).toEqual(
          expect.objectContaining({
            modelPath: chat,
            draftModelPath: undefined,
          }),
        );
      },
    );
  });

  it("auto-pairs a bundled chat GGUF with its MTP drafter when explicitly enabled", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-mtp-model-"));
    const textDir = path.join(root, "eliza-1-2b.bundle", "text");
    const mtpDir = path.join(root, "eliza-1-2b.bundle", "mtp");
    mkdirSync(textDir, { recursive: true });
    mkdirSync(mtpDir, { recursive: true });
    const chat = path.join(textDir, "eliza-1-2b-32k.gguf");
    const drafter = path.join(mtpDir, "drafter-2b.gguf");
    writeFileSync(chat, "chat");
    writeFileSync(drafter, "draft");

    withEnv(
      {
        ELIZA_MOBILE_PLATFORM: "android",
        ELIZA_MTP: "1",
        ELIZA_MTP_SERVER_SPAWN: undefined,
      },
      () => {
        expect(buildAospLoadModelArgs("chat", chat)).toEqual(
          expect.objectContaining({
            modelPath: chat,
            draftModelPath: drafter,
            draftContextSize: 2048,
            draftMin: 1,
            draftMax: 16,
            kvCacheType: {
              k: "q8_0",
              v: "f16",
            },
          }),
        );
      },
    );
  });

  it("does not enable MTP when target-meta says the drafter is the target bytes", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-mtp-copy-"));
    const textDir = path.join(root, "eliza-1-2b.bundle", "text");
    const mtpDir = path.join(root, "eliza-1-2b.bundle", "mtp");
    mkdirSync(textDir, { recursive: true });
    mkdirSync(mtpDir, { recursive: true });
    const chat = path.join(textDir, "eliza-1-2b-32k.gguf");
    const drafter = path.join(mtpDir, "drafter-2b.gguf");
    writeFileSync(chat, "same-model");
    writeFileSync(drafter, "same-model");
    writeFileSync(
      path.join(mtpDir, "target-meta.json"),
      JSON.stringify({
        targetText: { sha256: "a".repeat(64) },
        drafter: { sha256: "a".repeat(64) },
      }),
    );

    withEnv(
      {
        ELIZA_MOBILE_PLATFORM: "android",
        ELIZA_MTP: "1",
        ELIZA_MTP_SERVER_SPAWN: undefined,
      },
      () => {
        expect(buildAospLoadModelArgs("chat", chat)).toEqual(
          expect.objectContaining({
            modelPath: chat,
            draftModelPath: undefined,
          }),
        );
      },
    );
  });
});

describe("readAssignedBundledModels", () => {
  it("prefers assigned registry models over directory scan order", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-assigned-models-"));
    const modelsDir = path.join(root, "local-inference", "models");
    const smallBundle = path.join(modelsDir, "eliza-1-2b.bundle", "text");
    const defaultBundle = path.join(modelsDir, "eliza-1-2b.bundle", "text");
    const embeddingDir = path.join(modelsDir, "bge-small-en-v1.5");
    mkdirSync(smallBundle, { recursive: true });
    mkdirSync(defaultBundle, { recursive: true });
    mkdirSync(embeddingDir, { recursive: true });
    const smallModel = path.join(smallBundle, "eliza-1-2b-32k.gguf");
    const defaultModel = path.join(defaultBundle, "eliza-1-2b-32k.gguf");
    const embeddingModel = path.join(
      embeddingDir,
      "bge-small-en-v1.5-q4_k_m.gguf",
    );
    writeFileSync(smallModel, "small");
    writeFileSync(defaultModel, "default");
    writeFileSync(embeddingModel, "embed");
    writeFileSync(
      path.join(root, "local-inference", "assignments.json"),
      JSON.stringify({
        version: 1,
        assignments: {
          TEXT_SMALL: "eliza-1-2b",
          TEXT_EMBEDDING: "bge-small-en-v1.5",
        },
      }),
    );
    writeFileSync(
      path.join(root, "local-inference", "registry.json"),
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "eliza-1-2b",
            path: smallModel,
            source: "eliza-download",
          },
          {
            id: "eliza-1-2b",
            path: defaultModel,
            source: "eliza-download",
          },
          {
            id: "bge-small-en-v1.5",
            path: embeddingModel,
            source: "eliza-download",
          },
        ],
      }),
    );

    expect(readAssignedBundledModels(modelsDir)).toEqual({
      chat: defaultModel,
      embedding: embeddingModel,
    });
  });

  it("maps registry paths copied from another state root into the current device root", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-assigned-remap-"));
    const modelsDir = path.join(root, "local-inference", "models");
    const defaultBundle = path.join(modelsDir, "eliza-1-2b.bundle", "text");
    mkdirSync(defaultBundle, { recursive: true });
    const defaultModel = path.join(defaultBundle, "eliza-1-2b-32k.gguf");
    writeFileSync(defaultModel, "default");
    writeFileSync(
      path.join(root, "local-inference", "assignments.json"),
      JSON.stringify({
        version: 1,
        assignments: { TEXT_SMALL: "eliza-1-2b" },
      }),
    );
    writeFileSync(
      path.join(root, "local-inference", "registry.json"),
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "eliza-1-2b",
            path: "/home/nubs/.eliza/local-inference/models/eliza-1-2b.bundle/text/eliza-1-2b-32k.gguf",
            source: "eliza-download",
          },
        ],
      }),
    );

    expect(readAssignedBundledModels(modelsDir).chat).toBe(defaultModel);
  });

  it("resolves container-relative registry rows against the current device root (#11669)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-assigned-relative-"));
    const modelsDir = path.join(root, "local-inference", "models");
    const defaultBundle = path.join(modelsDir, "eliza-1-2b.bundle", "text");
    mkdirSync(defaultBundle, { recursive: true });
    const defaultModel = path.join(defaultBundle, "eliza-1-2b-32k.gguf");
    writeFileSync(defaultModel, "default");
    writeFileSync(
      path.join(root, "local-inference", "assignments.json"),
      JSON.stringify({
        version: 1,
        assignments: { TEXT_SMALL: "eliza-1-2b" },
      }),
    );
    writeFileSync(
      path.join(root, "local-inference", "registry.json"),
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "eliza-1-2b",
            path: "models/eliza-1-2b.bundle/text/eliza-1-2b-32k.gguf",
            source: "eliza-download",
          },
        ],
      }),
    );

    expect(readAssignedBundledModels(modelsDir).chat).toBe(defaultModel);
  });

  it("returns no chat model when the registry row's artifact is genuinely absent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-assigned-missing-"));
    const modelsDir = path.join(root, "local-inference", "models");
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(
      path.join(root, "local-inference", "assignments.json"),
      JSON.stringify({
        version: 1,
        assignments: { TEXT_SMALL: "eliza-1-2b" },
      }),
    );
    writeFileSync(
      path.join(root, "local-inference", "registry.json"),
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "eliza-1-2b",
            path: "models/eliza-1-2b.bundle/text/eliza-1-2b-32k.gguf",
            source: "eliza-download",
          },
        ],
      }),
    );

    expect(readAssignedBundledModels(modelsDir).chat).toBeNull();
  });
});

describe("removeAospGeneratedStagingDir", () => {
  it("removes only generated staging directories under the active bundle", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-staging-cleanup-"));
    const bundleRoot = path.join(root, "local-inference", "models", "2b");
    const stagingDir = path.join(bundleRoot, "tts", "kokoro.staging");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(path.join(stagingDir, "partial.gguf"), "partial");

    removeAospGeneratedStagingDir(stagingDir, bundleRoot);

    expect(existsSync(stagingDir)).toBe(false);
  });

  it("refuses non-staging, bundle-root, cwd, root, and escaped paths", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-staging-guard-"));
    const bundleRoot = path.join(root, "bundle");
    mkdirSync(bundleRoot, { recursive: true });

    for (const candidate of [
      path.join(bundleRoot, "tts"),
      bundleRoot,
      process.cwd(),
      path.parse(bundleRoot).root,
      path.join(root, "outside.staging"),
    ]) {
      expect(() =>
        removeAospGeneratedStagingDir(candidate, bundleRoot),
      ).toThrow(/Refusing to remove unsafe staging directory/);
    }
  });
});

describe("aospAsrAssetsPresent (TRANSCRIPTION registration gate)", () => {
  function seedChatBundle(root: string): void {
    const modelsDir = path.join(root, "local-inference", "models");
    const textDir = path.join(modelsDir, "eliza-1-2b.bundle", "text");
    mkdirSync(textDir, { recursive: true });
    const chatModel = path.join(textDir, "eliza-1-2b-32k.gguf");
    writeFileSync(chatModel, "chat");
    writeFileSync(
      path.join(root, "local-inference", "assignments.json"),
      JSON.stringify({ version: 1, assignments: { TEXT_SMALL: "eliza-1-2b" } }),
    );
    writeFileSync(
      path.join(root, "local-inference", "registry.json"),
      JSON.stringify({
        version: 1,
        models: [
          { id: "eliza-1-2b", path: chatModel, source: "eliza-download" },
        ],
      }),
    );
  }

  it("returns true only when an asr/ dir sits next to the chat bundle", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-asr-present-"));
    seedChatBundle(root);
    expect(
      withEnv({ ELIZA_STATE_DIR: root }, () => aospAsrAssetsPresent()),
    ).toBe(false);
    mkdirSync(
      path.join(root, "local-inference", "models", "eliza-1-2b.bundle", "asr"),
      {
        recursive: true,
      },
    );
    expect(
      withEnv({ ELIZA_STATE_DIR: root }, () => aospAsrAssetsPresent()),
    ).toBe(true);
  });

  it("returns false (never throws) when no chat bundle is installed", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-asr-nobundle-"));
    expect(
      withEnv({ ELIZA_STATE_DIR: root }, () => aospAsrAssetsPresent()),
    ).toBe(false);
  });
});

describe("resolveAospGenerateTokenBudget", () => {
  it("caps oversized caller budgets with the Android debug env cap", () => {
    expect(
      resolveAospGenerateTokenBudget({
        requestedMaxTokens: 8192,
        nCtx: 4096,
        nBatch: 64,
        env: { ELIZA_LLAMA_MAX_OUTPUT_TOKENS: "384" },
      }),
    ).toMatchObject({
      requestedMaxTokens: 8192,
      maxTokens: 384,
      maxOutputReserve: 384,
      envCap: 384,
      capped: true,
    });
  });

  it("uses a stock-Android-safe output cap by default", () => {
    expect(
      resolveAospGenerateTokenBudget({
        requestedMaxTokens: 8192,
        nCtx: 4096,
        nBatch: 64,
        env: {},
      }),
    ).toMatchObject({
      requestedMaxTokens: 8192,
      maxTokens: 256,
      maxOutputReserve: 256,
      contextCap: 2016,
      envCap: 256,
      capped: true,
    });
  });

  it("can explicitly disable the default output cap for diagnostics", () => {
    expect(
      resolveAospGenerateTokenBudget({
        requestedMaxTokens: 8192,
        nCtx: 4096,
        nBatch: 64,
        env: { ELIZA_LLAMA_MAX_OUTPUT_TOKENS: "0" },
      }),
    ).toMatchObject({
      requestedMaxTokens: 8192,
      maxTokens: 2016,
      maxOutputReserve: 2016,
      contextCap: 2016,
      envCap: null,
      capped: true,
    });
  });
});

describe("firstSentenceEndIndex", () => {
  it("does not stop on a partial streaming decimal", () => {
    expect(firstSentenceEndIndex("local Pixel 0.", 1)).toBe(-1);
    expect(firstSentenceEndIndex("local Pixel 0.8B is active.", 1)).toBe(27);
  });
});

describe("AOSP embedding gate", () => {
  it("keeps native embeddings opt-in on Android", () => {
    expect(isAospLocalEmbeddingEnabled({})).toBe(false);
    expect(
      isAospLocalEmbeddingEnabled({ ELIZA_LOCAL_EMBEDDING_ENABLED: "1" }),
    ).toBe(true);
  });

  it("returns a SQL-compatible zero vector while native embeddings are disabled", () => {
    expect(disabledAospEmbeddingVector({})).toHaveLength(384);
    expect(
      disabledAospEmbeddingVector({ LOCAL_EMBEDDING_DIMENSIONS: "1024" }),
    ).toHaveLength(1024);
  });
});

describe("AOSP TEXT_TO_SPEECH backend selection", () => {
  it("routes every request through the Kokoro FFI handler", async () => {
    const calls: string[] = [];
    const handler = makeAospTextToSpeechHandler({
      kokoro: async () => {
        calls.push("kokoro");
        return new Uint8Array([1, 2, 3]);
      },
    });

    await expect(handler({} as never, "hello")).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(calls).toEqual(["kokoro"]);
  });

  it("propagates Kokoro failures verbatim (no silent fallback)", async () => {
    const handler = makeAospTextToSpeechHandler({
      kokoro: async () => {
        throw new Error("missing lib");
      },
    });

    await expect(handler({} as never, "hello")).rejects.toThrow("missing lib");
  });

  it("invokes the foreground-use hook on every request", async () => {
    let foreground = 0;
    const handler = makeAospTextToSpeechHandler({
      kokoro: async () => new Uint8Array([0]),
      onForegroundUse: () => {
        foreground++;
      },
    });
    await handler({} as never, "one");
    await handler({} as never, "two");
    expect(foreground).toBe(2);
  });
});

describe("buildAospLoadModelArgs", () => {
  it("uses the Gemma KV defaults for chat models (q8_0 K, f16 V — V-quant needs FA, off on Android; QJL/Polar retired post-#9033)", () => {
    expect(buildAospLoadModelArgs("chat", "/models/chat.gguf")).toEqual({
      modelPath: "/models/chat.gguf",
      contextSize: 4096,
      draftModelPath: undefined,
      draftContextSize: undefined,
      draftMin: undefined,
      draftMax: undefined,
      useGpu: false,
      gpuLayers: 0,
      kvCacheType: {
        k: "q8_0",
        v: "f16",
      },
    });
  });

  it("honours explicit KV-cache env overrides and rejects junk names", () => {
    const prevK = process.env.ELIZA_LLAMA_KV_TYPE_K;
    const prevV = process.env.ELIZA_LLAMA_KV_TYPE_V;
    try {
      process.env.ELIZA_LLAMA_KV_TYPE_K = "f16";
      process.env.ELIZA_LLAMA_KV_TYPE_V = "garbage";
      const args = buildAospLoadModelArgs("chat", "/models/chat.gguf");
      expect(args.kvCacheType).toEqual({ k: "f16", v: "f16" });
    } finally {
      if (prevK === undefined) delete process.env.ELIZA_LLAMA_KV_TYPE_K;
      else process.env.ELIZA_LLAMA_KV_TYPE_K = prevK;
      if (prevV === undefined) delete process.env.ELIZA_LLAMA_KV_TYPE_V;
      else process.env.ELIZA_LLAMA_KV_TYPE_V = prevV;
    }
  });

  it("keeps embedding loads on small f16 KV so BGE does not inherit chat KV", () => {
    expect(
      buildAospLoadModelArgs("embedding", "/models/bge-small.gguf"),
    ).toEqual({
      modelPath: "/models/bge-small.gguf",
      contextSize: 512,
      useGpu: false,
      gpuLayers: 0,
      kvCacheType: {
        k: "f16",
        v: "f16",
      },
    });
  });
});

describe("parseMemAvailableMb", () => {
  it("parses MemAvailable from real /proc/meminfo layout (kB → MiB)", () => {
    const meminfo = [
      "MemTotal:        7752748 kB",
      "MemFree:          477508 kB",
      "MemAvailable:    4147956 kB",
      "Buffers:           12345 kB",
    ].join("\n");
    // 4147956 kB / 1024 ≈ 4050.7 MiB
    expect(parseMemAvailableMb(meminfo)).toBeCloseTo(4147956 / 1024, 3);
  });

  it("tolerates a single-space layout and trailing fields", () => {
    expect(parseMemAvailableMb("MemAvailable: 2048000 kB")).toBeCloseTo(
      2000,
      3,
    );
  });

  it("returns null when MemAvailable is absent", () => {
    expect(parseMemAvailableMb("MemTotal: 100 kB\nMemFree: 50 kB")).toBeNull();
    expect(parseMemAvailableMb("")).toBeNull();
  });
});

describe("shouldEvictChatForAvailMb (memory-gated chat eviction)", () => {
  it("KEEPS the chat model when there is headroom (no SEND-stalling reload)", () => {
    // ~4 GB free → well above the keep threshold → do not evict.
    expect(shouldEvictChatForAvailMb(4050)).toBe(false);
    expect(shouldEvictChatForAvailMb(VOICE_COLOAD_KEEP_AVAIL_MB)).toBe(false);
    expect(shouldEvictChatForAvailMb(VOICE_COLOAD_KEEP_AVAIL_MB + 1)).toBe(
      false,
    );
  });

  it("EVICTS the chat model under genuine memory pressure (OOM protection)", () => {
    expect(shouldEvictChatForAvailMb(VOICE_COLOAD_KEEP_AVAIL_MB - 1)).toBe(
      true,
    );
    expect(shouldEvictChatForAvailMb(1500)).toBe(true);
    expect(shouldEvictChatForAvailMb(0)).toBe(true);
  });

  it("evicts on unknown memory (safe default = original always-evict)", () => {
    expect(shouldEvictChatForAvailMb(null)).toBe(true);
  });
});
