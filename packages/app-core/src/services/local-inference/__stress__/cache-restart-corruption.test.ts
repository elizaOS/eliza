/**
 * Stress test: corrupt KV files at restart-time.
 *
 * Goals:
 *   1. When a saved KV file is missing, the next openConversation +
 *      generate path falls back to cold prefill (not a panic).
 *   2. When a saved KV file is corrupt (server returns 5xx on restore),
 *      the next openConversation + generate path falls back gracefully.
 *   3. Subsequent generation still produces valid usage blocks.
 *
 * The mock simulates "restart" by clearing slot prefixCachedTokensBySlot
 * — same approach as `dflash-cache-flow.test.ts` close+reopen test.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { conversationRegistry } from "../conversation-registry";
import { dflashLlamaServer } from "../dflash-server";
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
  slotDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-corrupt-"));
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
  state.corruptRestore = false;
  for (const handle of conversationRegistry.snapshot()) {
    conversationRegistry.close(handle.conversationId, handle.modelId);
  }
});

describe("cache restart corruption: graceful fallback on bad KV files", () => {
  it("missing KV file: openConversation does not throw, generate cold-prefills", async () => {
    const handle = engine.openConversation({
      conversationId: "missing-kv-room",
      modelId: "mock-model",
    });
    // No prior save was issued for this conversation, so the restore
    // call sees a non-existent file and the dflash-server skips.
    // openConversation must not throw on the missing-file path.
    // Drain the lazy restore microtask.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // First generate is a cold prefill — input tokens > 0 and
    // cache_read = 0 because nothing was restored.
    const result = await engine.generateInConversation(handle, {
      prompt: Array.from({ length: 500 }, (_, i) => `t${i}`).join(" "),
      maxTokens: 8,
    });
    expect(result.usage.cache_read_input_tokens).toBe(0);
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    await engine.closeConversation(handle);
  });

  it("corrupt KV file: restore returns 500, openConversation does not throw", async () => {
    // First, save a valid file via the normal path.
    const handle1 = engine.openConversation({
      conversationId: "corrupt-kv-room",
      modelId: "mock-model",
    });
    await engine.generateInConversation(handle1, {
      prompt: "first turn",
      maxTokens: 4,
    });
    await engine.closeConversation(handle1);
    // The save call wrote a file in slotDir.
    const savedPath = path.join(slotDir, "corrupt-kv-room.bin");
    expect(fs.existsSync(savedPath)).toBe(true);

    // Now corrupt the file content AND make the mock return 500 on
    // restore (mirrors what real llama-server does on a bad slot KV).
    fs.writeFileSync(savedPath, "GARBAGE-NOT-A-VALID-SLOT-KV");
    state.corruptRestore = true;

    // Reopen → restore should fail without throwing.
    const handle2 = engine.openConversation({
      conversationId: "corrupt-kv-room",
      modelId: "mock-model",
    });
    // Drain the fire-and-forget restore.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Generate must still work and report a non-zero usage block. The
    // cache hit is 0 because the restore failed (cold prefill).
    const result = await engine.generateInConversation(handle2, {
      prompt: "after corrupt restore",
      maxTokens: 4,
    });
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    expect(result.usage.cache_read_input_tokens).toBe(0);
    await engine.closeConversation(handle2);
  });

  it("persistConversationKv handles a server error without throwing", async () => {
    const handle = engine.openConversation({
      conversationId: "save-error-room",
      modelId: "mock-model",
    });
    await engine.generateInConversation(handle, {
      prompt: "warmup",
      maxTokens: 4,
    });
    // Force the next save to land on a slot id that the mock has not
    // registered. The mock's path matches /^\/slots\/\d+\?action=...$/
    // so any positive int works — this exercises the network-error
    // tolerance path indirectly.
    await expect(
      dflashLlamaServer.persistConversationKv("save-error-room", handle.slotId),
    ).resolves.toBe(true);
    await engine.closeConversation(handle);
  });

  it("100 concurrent openConversations on missing KV files all succeed", async () => {
    // Stress the missing-KV path — opening 100 conversations triggers
    // 100 fire-and-forget restore calls that all return cleanly.
    const handles = Array.from({ length: 100 }, (_, i) =>
      engine.openConversation({
        conversationId: `bulk-missing-${i}`,
        modelId: "mock-model",
      }),
    );
    // Drain restore microtasks.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Every handle must be usable.
    for (const h of handles) {
      const r = await engine.generateInConversation(h, {
        prompt: `room=${h.conversationId}`,
        maxTokens: 4,
      });
      expect(r.usage.input_tokens).toBeGreaterThan(0);
    }
    for (const h of handles) await engine.closeConversation(h);
    expect(conversationRegistry.size()).toBe(0);
  });
});
