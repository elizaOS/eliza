import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  firstSentenceEndIndex,
  resolveAospGenerateTokenBudget,
} from "../src/aosp-llama-adapter";
import {
  buildAospLoadModelArgs,
  buildGenerateArgsFromParams,
  disabledAospEmbeddingVector,
  flattenGenerateTextParamsForAospPrompt,
  isAospLocalEmbeddingEnabled,
  makeAospTextToSpeechHandler,
  readAssignedBundledModels,
  resolveAospOmnivoiceConfig,
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
        "system:\nStage 1 instructions",
        "user:\nSay pixel bundle ok.",
        "assistant:",
      ].join("\n\n"),
    );
  });

  it("prepends params.system when messages do not include a system message", () => {
    expect(
      flattenGenerateTextParamsForAospPrompt({
        system: "You are Eliza.",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toBe(
      ["system:\nYou are Eliza.", "user:\nhello", "assistant:"].join("\n\n"),
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
      prompt: "user:\nhello\n\nassistant:",
      maxTokens: 384,
      temperature: 0,
      grammar: 'root ::= "ok"',
      signal: ctrl.signal,
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
  it("leaves bundled DFlash disabled by default on stock Android", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-dflash-model-"));
    const textDir = path.join(root, "eliza-1-0_8b.bundle", "text");
    const dflashDir = path.join(root, "eliza-1-0_8b.bundle", "dflash");
    mkdirSync(textDir, { recursive: true });
    mkdirSync(dflashDir, { recursive: true });
    const chat = path.join(textDir, "eliza-1-0_8b-32k.gguf");
    const drafter = path.join(dflashDir, "drafter-0_8b.gguf");
    writeFileSync(chat, "chat");
    writeFileSync(drafter, "draft");

    withEnv(
      {
        ELIZA_MOBILE_PLATFORM: "android",
        ELIZA_DFLASH: undefined,
        ELIZA_DFLASH_SERVER_SPAWN: undefined,
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

  it("auto-pairs a publish-eligible bundled DFlash drafter on stock Android", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-dflash-auto-"));
    const textDir = path.join(root, "eliza-1-0_8b.bundle", "text");
    const dflashDir = path.join(root, "eliza-1-0_8b.bundle", "dflash");
    mkdirSync(textDir, { recursive: true });
    mkdirSync(dflashDir, { recursive: true });
    const chat = path.join(textDir, "eliza-1-0_8b-32k.gguf");
    const drafter = path.join(dflashDir, "drafter-0_8b.gguf");
    writeFileSync(chat, "chat");
    writeFileSync(drafter, "draft");
    writeFileSync(
      path.join(dflashDir, "target-meta.json"),
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
        ELIZA_DFLASH: undefined,
        ELIZA_DFLASH_SERVER_SPAWN: undefined,
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

  it("does not auto-pair candidate DFlash metadata on stock Android", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-dflash-candidate-"));
    const textDir = path.join(root, "eliza-1-2b.bundle", "text");
    const dflashDir = path.join(root, "eliza-1-2b.bundle", "dflash");
    mkdirSync(textDir, { recursive: true });
    mkdirSync(dflashDir, { recursive: true });
    const chat = path.join(textDir, "eliza-1-2b-32k.gguf");
    const drafter = path.join(dflashDir, "drafter-2b.gguf");
    writeFileSync(chat, "chat");
    writeFileSync(drafter, "draft");
    writeFileSync(
      path.join(dflashDir, "target-meta.json"),
      JSON.stringify({
        publishEligible: false,
        targetText: { sha256: "a".repeat(64), sizeBytes: 1_270_808_512 },
        drafter: { sha256: "b".repeat(64), sizeBytes: 811_843_840 },
      }),
    );

    withEnv(
      {
        ELIZA_MOBILE_PLATFORM: "android",
        ELIZA_DFLASH: undefined,
        ELIZA_DFLASH_SERVER_SPAWN: undefined,
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

  it("auto-pairs a bundled chat GGUF with its DFlash drafter when explicitly enabled", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-dflash-model-"));
    const textDir = path.join(root, "eliza-1-0_8b.bundle", "text");
    const dflashDir = path.join(root, "eliza-1-0_8b.bundle", "dflash");
    mkdirSync(textDir, { recursive: true });
    mkdirSync(dflashDir, { recursive: true });
    const chat = path.join(textDir, "eliza-1-0_8b-32k.gguf");
    const drafter = path.join(dflashDir, "drafter-0_8b.gguf");
    writeFileSync(chat, "chat");
    writeFileSync(drafter, "draft");

    withEnv(
      {
        ELIZA_MOBILE_PLATFORM: "android",
        ELIZA_DFLASH: "1",
        ELIZA_DFLASH_SERVER_SPAWN: undefined,
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
              k: "qjl1_256",
              v: "q4_polar",
            },
          }),
        );
      },
    );
  });

  it("does not enable DFlash when target-meta says the drafter is the target bytes", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-dflash-copy-"));
    const textDir = path.join(root, "eliza-1-0_8b.bundle", "text");
    const dflashDir = path.join(root, "eliza-1-0_8b.bundle", "dflash");
    mkdirSync(textDir, { recursive: true });
    mkdirSync(dflashDir, { recursive: true });
    const chat = path.join(textDir, "eliza-1-0_8b-32k.gguf");
    const drafter = path.join(dflashDir, "drafter-0_8b.gguf");
    writeFileSync(chat, "same-model");
    writeFileSync(drafter, "same-model");
    writeFileSync(
      path.join(dflashDir, "target-meta.json"),
      JSON.stringify({
        targetText: { sha256: "a".repeat(64) },
        drafter: { sha256: "a".repeat(64) },
      }),
    );

    withEnv(
      {
        ELIZA_MOBILE_PLATFORM: "android",
        ELIZA_DFLASH: "1",
        ELIZA_DFLASH_SERVER_SPAWN: undefined,
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
    const smallBundle = path.join(modelsDir, "eliza-1-0_8b.bundle", "text");
    const defaultBundle = path.join(modelsDir, "eliza-1-2b.bundle", "text");
    const embeddingDir = path.join(modelsDir, "bge-small-en-v1.5");
    mkdirSync(smallBundle, { recursive: true });
    mkdirSync(defaultBundle, { recursive: true });
    mkdirSync(embeddingDir, { recursive: true });
    const smallModel = path.join(smallBundle, "eliza-1-0_8b-32k.gguf");
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
            id: "eliza-1-0_8b",
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
  it("does not stop on an incomplete streaming decimal", () => {
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
  it("routes every request through the OmniVoice FFI handler", async () => {
    const calls: string[] = [];
    const handler = makeAospTextToSpeechHandler({
      omnivoice: async () => {
        calls.push("omnivoice");
        return new Uint8Array([1, 2, 3]);
      },
    });

    await expect(handler({} as never, "hello")).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(calls).toEqual(["omnivoice"]);
  });

  it("propagates OmniVoice failures verbatim (no Kokoro fallback)", async () => {
    const handler = makeAospTextToSpeechHandler({
      omnivoice: async () => {
        throw new Error("missing lib");
      },
    });

    await expect(handler({} as never, "hello")).rejects.toThrow("missing lib");
  });

  it("invokes the foreground-use hook on every request", async () => {
    let foreground = 0;
    const handler = makeAospTextToSpeechHandler({
      omnivoice: async () => new Uint8Array([0]),
      onForegroundUse: () => {
        foreground++;
      },
    });
    await handler({} as never, "one");
    await handler({} as never, "two");
    expect(foreground).toBe(2);
  });

  it("resolves explicitly configured OmniVoice artifacts", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aosp-omnivoice-"));
    const libPath = path.join(root, "libomnivoice.so");
    const modelPath = path.join(root, "omnivoice-base-Q4_K_M.gguf");
    const codecPath = path.join(root, "omnivoice-tokenizer-Q4_K_M.gguf");
    writeFileSync(libPath, "lib");
    writeFileSync(modelPath, "model");
    writeFileSync(codecPath, "codec");

    expect(
      resolveAospOmnivoiceConfig({
        OMNIVOICE_LIB_PATH: libPath,
        OMNIVOICE_MODEL_PATH: modelPath,
        OMNIVOICE_CODEC_PATH: codecPath,
      } as NodeJS.ProcessEnv),
    ).toEqual({ libPath, modelPath, codecPath });
  });
});

describe("buildAospLoadModelArgs", () => {
  it("uses Eliza-1 compressed KV defaults for chat models", () => {
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
        k: "qjl1_256",
        v: "q4_polar",
      },
    });
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
