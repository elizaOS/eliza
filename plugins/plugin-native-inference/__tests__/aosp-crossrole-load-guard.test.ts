/**
 * Regression coverage for the fused loader's cross-role auto-load guard
 * (issue #30147). Drives the REAL registered TEXT_LARGE / TEXT_EMBEDDING
 * handlers through `ensureAospLocalInferenceHandlers` over a deterministic
 * barrier-backed AospLoader and a temp STATE_DIR manifest listing both a chat
 * and an embedding GGUF. The harness never touches the native FFI boundary; it
 * asserts which model is resident at generate/embed time, which is exactly the
 * bug's observable — a chat completion executing against the embedding model
 * (or vice versa) because both roles shared one in-flight promise.
 *
 * The barrier can pin a load in flight AND hold a generate()/embed() call open,
 * so the atomicity case proves the load-PLUS-use transaction is serialized: an
 * arriving cross-role request cannot swap the native context while the other
 * role's inference is still running. The resident model is recorded when each
 * call RETURNS, so a mid-call swap surfaces as a wrong-model observation.
 *
 * The eviction case drives the exported lifecycle's `evict()` (the seam the
 * voice ASR handler unloads through) directly, proving the out-of-band unload
 * is serialized on the same executor and so waits behind an in-flight embed
 * rather than freeing the native context out from under it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  type AospLoader,
  ensureAospLocalInferenceHandlers,
  makeLoaderLifecycle,
} from "../src/aosp-local-inference-bootstrap";

async function withEnvAsync<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function seedBothModels(stateDir: string): {
  chatPath: string;
  embeddingPath: string;
} {
  const modelsDir = path.join(stateDir, "local-inference", "models");
  mkdirSync(modelsDir, { recursive: true });
  const chatPath = path.join(modelsDir, "eliza-1-chat.gguf");
  const embeddingPath = path.join(modelsDir, "bge-embedding.gguf");
  writeFileSync(chatPath, "chat-model-bytes");
  writeFileSync(embeddingPath, "embedding-model-bytes");
  writeFileSync(
    path.join(modelsDir, "manifest.json"),
    JSON.stringify({
      models: [
        { role: "chat", ggufFile: path.basename(chatPath) },
        { role: "embedding", ggufFile: path.basename(embeddingPath) },
      ],
    }),
  );
  return { chatPath, embeddingPath };
}

interface BarrierLoader {
  loader: AospLoader;
  loadModelCalls: string[];
  generateResidentPaths: string[];
  embedResidentPaths: string[];
  started(marker: string): Promise<void>;
  release(marker: string): void;
  startedUse(marker: string): Promise<void>;
  releaseUse(marker: string): void;
}

function makeGate(markers: string[]): {
  wait(marker: string): Promise<void> | undefined;
  release(marker: string): void;
  started(marker: string): Promise<void>;
  signalStarted(marker: string): void;
} {
  const gates = new Map<string, Promise<void>>();
  const releasers = new Map<string, () => void>();
  const startedFlags = new Map<string, Promise<void>>();
  const startedSignals = new Map<string, () => void>();
  for (const marker of markers) {
    gates.set(
      marker,
      new Promise<void>((resolve) => releasers.set(marker, resolve)),
    );
    startedFlags.set(
      marker,
      new Promise<void>((resolve) => startedSignals.set(marker, resolve)),
    );
  }
  return {
    wait: (marker) => gates.get(marker),
    release: (marker) => releasers.get(marker)?.(),
    started: (marker) => startedFlags.get(marker) ?? Promise.resolve(),
    signalStarted: (marker) => startedSignals.get(marker)?.(),
  };
}

// Fake AospLoader whose loadModel blocks on a per-marker barrier so a test can
// pin one role's load in flight while a request for the OTHER role arrives.
// `holdUseOn` markers additionally block generate()/embed() while that GGUF is
// resident, so a test can hold one role's inference open and observe whether an
// arriving cross-role request swaps the context mid-call. `generate`/`embed`
// record which model is resident when they RETURN — the exact wrong-model
// observable of the bug. Passed through the real instrumented lifecycle by
// `ensureAospLocalInferenceHandlers`.
function makeBarrierLoader(
  blockLoadOn: string[],
  holdUseOn: string[] = [],
): BarrierLoader {
  const loadModelCalls: string[] = [];
  const generateResidentPaths: string[] = [];
  const embedResidentPaths: string[] = [];
  let currentPath: string | null = null;
  const loadGate = makeGate(blockLoadOn);
  const useGate = makeGate(holdUseOn);
  async function holdUse(resident: string | null): Promise<void> {
    for (const marker of holdUseOn) {
      if (resident?.endsWith(marker)) {
        useGate.signalStarted(marker);
        await useGate.wait(marker);
      }
    }
  }
  const loader: AospLoader = {
    async loadModel(args) {
      loadModelCalls.push(args.modelPath);
      for (const marker of blockLoadOn) {
        if (args.modelPath.endsWith(marker)) {
          loadGate.signalStarted(marker);
          await loadGate.wait(marker);
        }
      }
      currentPath = args.modelPath;
    },
    async unloadModel() {
      currentPath = null;
    },
    currentModelPath: () => currentPath,
    generate: async () => {
      await holdUse(currentPath);
      generateResidentPaths.push(currentPath ?? "<none>");
      return `gen:${currentPath}`;
    },
    embed: async () => {
      await holdUse(currentPath);
      embedResidentPaths.push(currentPath ?? "<none>");
      return { embedding: [0.1, 0.2], tokens: 1 };
    },
  };
  return {
    loader,
    loadModelCalls,
    generateResidentPaths,
    embedResidentPaths,
    started: (marker) => loadGate.started(marker),
    release: (marker) => loadGate.release(marker),
    startedUse: (marker) => useGate.started(marker),
    releaseUse: (marker) => useGate.release(marker),
  };
}

const crossRoleEnv = (stateDir: string) => ({
  ELIZA_LOCAL_LLAMA: "1",
  ELIZA_DISABLE_FFI_LLAMA: undefined,
  ELIZA_LOCAL_EMBEDDING_ENABLED: "1",
  ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD: "1",
  ELIZA_DISABLE_VOICE_AUTO_DOWNLOAD: "1",
  ELIZA_LOCAL_IDLE_UNLOAD_MS: "0",
  ELIZA_AOSP_TTS_PREWARM: "0",
  ELIZA_STATE_DIR: stateDir,
});

describe("AOSP fused loader cross-role in-flight guard (#30147)", () => {
  it("loads the chat model for a chat request racing an in-flight embedding load (no cross-role piggyback)", async () => {
    const stateDir = mkdtempSync(
      path.join(os.tmpdir(), "aosp-crossrole-repro-"),
    );
    const { chatPath, embeddingPath } = seedBothModels(stateDir);
    const barrier = makeBarrierLoader([
      "bge-embedding.gguf",
      "eliza-1-chat.gguf",
    ]);

    await withEnvAsync(crossRoleEnv(stateDir), async () => {
      const runtime = new AgentRuntime({ logLevel: "fatal" });
      try {
        await ensureAospLocalInferenceHandlers(runtime, {
          buildLoader: async () => barrier.loader,
          prewarm: false,
        });
        const embedHandler = runtime.getModel(ModelType.TEXT_EMBEDDING);
        const chatHandler = runtime.getModel(ModelType.TEXT_LARGE);
        if (!embedHandler || !chatHandler) {
          throw new Error("AOSP cross-role handlers not registered");
        }

        // (1) Embedding load starts from the nothing-resident state and blocks
        //     inside loadModel(embedding), holding the in-flight load.
        const embedPromise = embedHandler(runtime, "index this memory");
        await barrier.started("bge-embedding.gguf");
        // (2) A chat request arrives concurrently. Under the shared-inflight bug
        //     it awaited the embedding load and generated against the embedding
        //     model; role-aware tracking must load its own chat model instead.
        const chatPromise = chatHandler(runtime, { prompt: "hello there" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        // (3) Release the embedding load: the embedding call runs against the
        //     embedding model; the chat load then proceeds to its own model.
        barrier.release("bge-embedding.gguf");
        await expect(embedPromise).resolves.toEqual([0.1, 0.2]);
        expect(barrier.embedResidentPaths).toEqual([embeddingPath]);

        barrier.release("eliza-1-chat.gguf");
        await expect(chatPromise).resolves.toBe(`gen:${chatPath}`);

        // The chat model WAS loaded (never true under the bug) and the chat
        // generate ran against the chat model, not the embedding GGUF.
        expect(barrier.loadModelCalls).toEqual([embeddingPath, chatPath]);
        expect(barrier.generateResidentPaths).toEqual([chatPath]);
      } finally {
        await runtime.stop({ fast: true });
      }
    });
  });

  it("keeps load-plus-use atomic: an arriving chat request cannot swap the native context while an embedding call is still running", async () => {
    const stateDir = mkdtempSync(
      path.join(os.tmpdir(), "aosp-crossrole-atomic-"),
    );
    const { chatPath, embeddingPath } = seedBothModels(stateDir);
    // Nothing blocks at load time; the embed CALL is held open so a chat
    // request can try to race the in-flight embedding inference.
    const barrier = makeBarrierLoader([], ["bge-embedding.gguf"]);

    await withEnvAsync(crossRoleEnv(stateDir), async () => {
      const runtime = new AgentRuntime({ logLevel: "fatal" });
      try {
        await ensureAospLocalInferenceHandlers(runtime, {
          buildLoader: async () => barrier.loader,
          prewarm: false,
        });
        const embedHandler = runtime.getModel(ModelType.TEXT_EMBEDDING);
        const chatHandler = runtime.getModel(ModelType.TEXT_LARGE);
        if (!embedHandler || !chatHandler) {
          throw new Error("AOSP cross-role handlers not registered");
        }

        // (1) The embedding model loads and embed() enters, then blocks — the
        //     embedding transaction is still open on the native context.
        const embedPromise = embedHandler(runtime, "index this memory");
        await barrier.startedUse("bge-embedding.gguf");
        // (2) A chat request arrives while the embedding call is mid-flight.
        const chatPromise = chatHandler(runtime, { prompt: "hello there" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        // (3) The chat load MUST NOT have started: swapping the context now
        //     would unload the embedding model out from under the running
        //     embed() and persist a vector produced against the chat GGUF.
        //     Under a load-only guard the chat loadModel already fired here.
        expect(barrier.loadModelCalls).toEqual([embeddingPath]);

        // (4) Release the embedding call; it ran against the embedding model.
        barrier.releaseUse("bge-embedding.gguf");
        await expect(embedPromise).resolves.toEqual([0.1, 0.2]);
        expect(barrier.embedResidentPaths).toEqual([embeddingPath]);

        // (5) Only now does the chat swap happen, and the generate runs against
        //     the freshly-resident chat model.
        await expect(chatPromise).resolves.toBe(`gen:${chatPath}`);
        expect(barrier.loadModelCalls).toEqual([embeddingPath, chatPath]);
        expect(barrier.generateResidentPaths).toEqual([chatPath]);
      } finally {
        await runtime.stop({ fast: true });
      }
    });
  });

  it("dedups concurrent same-role embedding loads onto a single native load", async () => {
    const stateDir = mkdtempSync(
      path.join(os.tmpdir(), "aosp-crossrole-dedup-"),
    );
    const { embeddingPath } = seedBothModels(stateDir);
    const barrier = makeBarrierLoader(["bge-embedding.gguf"]);

    await withEnvAsync(crossRoleEnv(stateDir), async () => {
      const runtime = new AgentRuntime({ logLevel: "fatal" });
      try {
        await ensureAospLocalInferenceHandlers(runtime, {
          buildLoader: async () => barrier.loader,
          prewarm: false,
        });
        const embedHandler = runtime.getModel(ModelType.TEXT_EMBEDDING);
        if (!embedHandler) throw new Error("AOSP embedding handler missing");

        const first = embedHandler(runtime, "memory A");
        await barrier.started("bge-embedding.gguf");
        const second = embedHandler(runtime, "memory B");
        await new Promise((resolve) => setTimeout(resolve, 20));
        barrier.release("bge-embedding.gguf");
        await Promise.all([first, second]);

        // Two concurrent same-role requests share ONE load and both embed
        // against the resident embedding model.
        expect(barrier.loadModelCalls).toEqual([embeddingPath]);
        expect(barrier.embedResidentPaths).toEqual([
          embeddingPath,
          embeddingPath,
        ]);
      } finally {
        await runtime.stop({ fast: true });
      }
    });
  });

  it("routes an out-of-band eviction through the context executor so the unload waits behind an in-flight embed instead of dropping the model mid-call", async () => {
    const stateDir = mkdtempSync(
      path.join(os.tmpdir(), "aosp-crossrole-evict-"),
    );
    const { embeddingPath } = seedBothModels(stateDir);

    await withEnvAsync(crossRoleEnv(stateDir), async () => {
      let currentPath: string | null = null;
      const events: string[] = [];
      let signalEmbedIn!: () => void;
      let releaseEmbed!: () => void;
      const embedIn = new Promise<void>((resolve) => {
        signalEmbedIn = resolve;
      });
      const embedGate = new Promise<void>((resolve) => {
        releaseEmbed = resolve;
      });
      const loader: AospLoader = {
        loadModel: async (args) => {
          currentPath = args.modelPath;
        },
        unloadModel: async () => {
          events.push("unload");
          currentPath = null;
        },
        currentModelPath: () => currentPath,
        generate: async () => "gen",
        embed: async () => ({ embedding: [0.1, 0.2], tokens: 1 }),
      };
      const lifecycle = makeLoaderLifecycle(loader);

      // (1) An embedding transaction loads its model and enters the call, then
      //     blocks — the embedding model is resident and the context is busy.
      const embedPromise = lifecycle.withEmbedding(async () => {
        events.push("embed:start");
        signalEmbedIn();
        await embedGate;
        events.push("embed:end");
        return [0.1, 0.2];
      });
      await embedIn;
      expect(currentPath).toBe(embeddingPath);

      // (2) A voice eviction fires while the embed is mid-flight. Routed through
      //     the same serial executor, it MUST queue behind the running embed
      //     rather than unload the embedding model out from under it — the
      //     same-class window the load-plus-use serialization closes, reached
      //     through the unload door. A direct loader.unloadModel() would push
      //     "unload" into events here, before the embed returns.
      const evictPromise = lifecycle.evict();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual(["embed:start"]);

      // (3) Release the embed; only now does the queued eviction unload run, and
      //     the resident role is cleared for the next load.
      releaseEmbed();
      await embedPromise;
      await evictPromise;
      expect(events).toEqual(["embed:start", "embed:end", "unload"]);
      expect(currentPath).toBeNull();
    });
  });

  it("reloads the single native context on every role change, each call running against its own model", async () => {
    const stateDir = mkdtempSync(
      path.join(os.tmpdir(), "aosp-crossrole-swap-"),
    );
    const { chatPath, embeddingPath } = seedBothModels(stateDir);
    const barrier = makeBarrierLoader([]);

    await withEnvAsync(crossRoleEnv(stateDir), async () => {
      const runtime = new AgentRuntime({ logLevel: "fatal" });
      try {
        await ensureAospLocalInferenceHandlers(runtime, {
          buildLoader: async () => barrier.loader,
          prewarm: false,
        });
        const embedHandler = runtime.getModel(ModelType.TEXT_EMBEDDING);
        const chatHandler = runtime.getModel(ModelType.TEXT_LARGE);
        if (!embedHandler || !chatHandler) {
          throw new Error("AOSP cross-role handlers not registered");
        }

        await expect(chatHandler(runtime, { prompt: "one" })).resolves.toBe(
          `gen:${chatPath}`,
        );
        await expect(embedHandler(runtime, "index")).resolves.toEqual([
          0.1, 0.2,
        ]);
        await expect(chatHandler(runtime, { prompt: "two" })).resolves.toBe(
          `gen:${chatPath}`,
        );

        // Each role change reloads the single native context, and every call
        // runs against its own resident model.
        expect(barrier.loadModelCalls).toEqual([
          chatPath,
          embeddingPath,
          chatPath,
        ]);
        expect(barrier.generateResidentPaths).toEqual([chatPath, chatPath]);
        expect(barrier.embedResidentPaths).toEqual([embeddingPath]);
      } finally {
        await runtime.stop({ fast: true });
      }
    });
  });
});
