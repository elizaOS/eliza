/**
 * Multi-model isolation: two models loaded simultaneously must not
 * pollute each other's slots.
 *
 * The conversation registry's composite key is `${modelId}::${conversationId}`,
 * so even when two distinct conversations share the same conversationId
 * (room shared across model swaps, etc.), they get distinct registry
 * handles when modelId differs.
 *
 * This test exercises the registry behaviour. The dflash slot directory
 * is keyed by `cacheModelHash` (one directory per running server), so
 * in production swapping models would actually unload the previous
 * server. But in agentic loops the model is held constant per-handle,
 * and the registry's per-model isolation matters.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildModelHash, cacheRoot, llamaCacheRoot } from "../cache-bridge";
import { conversationRegistry } from "../conversation-registry";
import { LocalInferenceEngine } from "../engine";
import {
  type MockState,
  newMockState,
  patchDflashServer,
  patchEngineActiveBackend,
  startMockServer,
} from "./cache-stress-helpers";

let mock: { baseUrl: string; close: () => Promise<void> } | null = null;
let restoreServer: () => void = () => {};
let restoreEngine: () => void = () => {};
let state: MockState = newMockState();
let engine: LocalInferenceEngine;
let slotDir: string = "";

beforeAll(async () => {
  state = newMockState();
  slotDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-multi-model-"));
  mock = await startMockServer(state, slotDir);
  restoreServer = patchDflashServer(mock.baseUrl, slotDir, 4);
  engine = new LocalInferenceEngine();
  restoreEngine = patchEngineActiveBackend(engine);
});

afterAll(async () => {
  restoreEngine();
  restoreServer();
  await mock?.close();
  if (slotDir) fs.rmSync(slotDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const handle of conversationRegistry.snapshot()) {
    conversationRegistry.close(handle.conversationId, handle.modelId);
  }
});

describe("cache multi-model: per-model isolation", () => {
  it("same conversationId on two models: distinct handles, can co-exist", () => {
    const onModelA = engine.openConversation({
      conversationId: "shared-room",
      modelId: "model-A",
    });
    const onModelB = engine.openConversation({
      conversationId: "shared-room",
      modelId: "model-B",
    });
    // Distinct handles — closing one doesn't affect the other.
    expect(onModelA).not.toBe(onModelB);
    expect(onModelA.modelId).toBe("model-A");
    expect(onModelB.modelId).toBe("model-B");
  });

  it("close on one model leaves the other model's handle live", async () => {
    const onModelA = engine.openConversation({
      conversationId: "iso-room",
      modelId: "model-A",
    });
    const onModelB = engine.openConversation({
      conversationId: "iso-room",
      modelId: "model-B",
    });
    await engine.closeConversation(onModelA);
    expect(engine.conversation("iso-room", "model-A")).toBeNull();
    const stillLiveB = engine.conversation("iso-room", "model-B");
    expect(stillLiveB).not.toBeNull();
    expect(stillLiveB?.conversationId).toBe("iso-room");
    expect(stillLiveB?.modelId).toBe("model-B");
    await engine.closeConversation(onModelB);
  });

  it("on-disk cache root differs per model hash (no slot directory pollution)", () => {
    // Switching active model also switches the slot directory.
    const hashA = buildModelHash({
      targetModelPath: "/models/qwen.gguf",
      drafterModelPath: "/models/qwen-drafter.gguf",
      cacheTypeK: "f16",
      cacheTypeV: "f16",
    });
    const hashB = buildModelHash({
      targetModelPath: "/models/llama.gguf",
      drafterModelPath: "/models/llama-drafter.gguf",
      cacheTypeK: "f16",
      cacheTypeV: "f16",
    });
    expect(hashA).not.toBe(hashB);
    const rootA = cacheRoot(hashA);
    const rootB = cacheRoot(hashB);
    expect(rootA).not.toBe(rootB);
    expect(rootA.startsWith(llamaCacheRoot())).toBe(true);
    expect(rootB.startsWith(llamaCacheRoot())).toBe(true);
  });

  it("recommendedParallel sums across models (registry is global)", () => {
    // Open 6 conversations split across two models. The registry tracks
    // a single high-water mark across all models, which is intentional —
    // the runtime has one llama-server process at a time and parallel
    // applies to that singleton. The recommendation must reflect total
    // load, not per-model load.
    const handles = [
      engine.openConversation({ conversationId: "c1", modelId: "model-A" }),
      engine.openConversation({ conversationId: "c2", modelId: "model-A" }),
      engine.openConversation({ conversationId: "c3", modelId: "model-A" }),
      engine.openConversation({ conversationId: "c1", modelId: "model-B" }),
      engine.openConversation({ conversationId: "c2", modelId: "model-B" }),
      engine.openConversation({ conversationId: "c3", modelId: "model-B" }),
    ];
    expect(engine.conversationHighWaterMark()).toBeGreaterThanOrEqual(6);
    for (const h of handles) {
      // Best-effort cleanup.
      conversationRegistry.close(h.conversationId, h.modelId);
    }
  });

  it("100 conversations distributed across 4 models maintain distinct registry entries", () => {
    const N = 100;
    const MODELS = 4;
    const handles = [];
    for (let i = 0; i < N; i += 1) {
      const modelId = `model-${i % MODELS}`;
      handles.push(
        engine.openConversation({
          conversationId: `room-${i}`,
          modelId,
        }),
      );
    }
    expect(conversationRegistry.size()).toBe(N);
    // Verify per-model lookup is stable.
    for (let i = 0; i < N; i += 1) {
      const modelId = `model-${i % MODELS}`;
      const h = engine.conversation(`room-${i}`, modelId);
      expect(h).not.toBeNull();
      expect(h?.modelId).toBe(modelId);
    }
    for (const h of handles) {
      conversationRegistry.close(h.conversationId, h.modelId);
    }
    expect(conversationRegistry.size()).toBe(0);
  });

  it("a conversation closed on model-A does not interfere with model-B's slot ownership", async () => {
    // Open and use a conversation on model-A.
    const onA = engine.openConversation({
      conversationId: "X",
      modelId: "model-A",
    });
    await engine.generateInConversation(onA, {
      prompt: "model-A turn 1",
      maxTokens: 4,
    });
    const slotForA = onA.slotId;

    // Open the same conversationId on model-B.
    const onB = engine.openConversation({
      conversationId: "X",
      modelId: "model-B",
    });
    await engine.generateInConversation(onB, {
      prompt: "model-B turn 1",
      maxTokens: 4,
    });
    const slotForB = onB.slotId;

    // Both are distinct handles; the slot allocation is independent
    // (lowest-loaded — they may collide on the same slot when load is
    // equal, but the handles themselves are independent).
    expect(slotForA).toBeGreaterThanOrEqual(0);
    expect(slotForB).toBeGreaterThanOrEqual(0);

    // Close model-A's handle. model-B's handle must still be usable.
    await engine.closeConversation(onA);
    const result = await engine.generateInConversation(onB, {
      prompt: "model-B turn 2",
      maxTokens: 4,
    });
    expect(result.text).toContain("mock");
    expect(result.slotId).toBe(slotForB);
    await engine.closeConversation(onB);
  });
});
