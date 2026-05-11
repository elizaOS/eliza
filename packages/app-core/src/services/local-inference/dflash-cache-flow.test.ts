/**
 * Integration test for the dflash-server cache flow against an in-process
 * mock that simulates llama-server's HTTP surface:
 *
 *   - GET /health, GET /v1/models                  → readiness probes
 *   - POST /v1/chat/completions                    → returns deterministic text
 *                                                    + counts cache hits per
 *                                                    `slot_id`
 *   - GET /metrics                                 → Prometheus exposition
 *                                                    that the cache-flow path
 *                                                    scrapes for usage
 *   - POST /slots/<id>?action=save / restore       → record save/restore for
 *                                                    cross-restart KV reuse
 *
 * The test does NOT spawn the real `llama-server` binary. It replaces the
 * `child` field of the `DflashLlamaServer` singleton with a sentinel and
 * sets `baseUrl` to point at the mock; everything below the public API
 * surface still runs real production code.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { conversationRegistry } from "./conversation-registry";
import { dflashLlamaServer } from "./dflash-server";
import { LocalInferenceEngine } from "./engine";

interface MockState {
  /** Per-slot fresh-prefill counter; resets when the slot is restored. */
  freshPrefillBySlot: Map<number, number>;
  /** Per-slot cache-hit-by-prefix-token counter. */
  cacheHitsBySlot: Map<number, number>;
  /** Per-slot save/restore log: ["save:5", "restore:5"]. */
  slotEvents: string[];
  /** Aggregated counters surfaced via GET /metrics. */
  promptTokensTotal: number;
  promptTokensProcessedTotal: number;
  predictedTokensTotal: number;
  draftedTotal: number;
  acceptedTotal: number;
  /** Synthetic "in-RAM cache" — slots remember their prefix length. */
  prefixCachedTokensBySlot: Map<number, number>;
}

function newMockState(): MockState {
  return {
    freshPrefillBySlot: new Map(),
    cacheHitsBySlot: new Map(),
    slotEvents: [],
    promptTokensTotal: 0,
    promptTokensProcessedTotal: 0,
    predictedTokensTotal: 0,
    draftedTotal: 0,
    acceptedTotal: 0,
    prefixCachedTokensBySlot: new Map(),
  };
}

/**
 * Spin up a tiny HTTP server that pretends to be llama-server. Returns
 * the base URL plus a handle for inspecting the synthetic state.
 *
 * `slotDir` is the directory the mock writes save-events into so the
 * dflash-server's `restoreConversationKv` can find them — it checks
 * `fs.existsSync(sourcePath)` before issuing a restore call.
 */
async function startMockServer(
  state: MockState,
  slotDir: string,
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/health") {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "GET" && url === "/v1/models") {
      res.statusCode = 200;
      res.end(JSON.stringify({ data: [{ id: "mock" }] }));
      return;
    }
    if (req.method === "GET" && url === "/metrics") {
      const body = [
        `llamacpp:prompt_tokens_total ${state.promptTokensTotal}`,
        `llamacpp:n_tokens_predicted_total ${state.predictedTokensTotal}`,
        `llamacpp:n_prompt_tokens_processed_total ${state.promptTokensProcessedTotal}`,
        `llamacpp:n_drafted_total ${state.draftedTotal}`,
        `llamacpp:n_accepted_total ${state.acceptedTotal}`,
        `llamacpp:kv_cache_tokens 0`,
        `llamacpp:kv_cache_used_cells 0`,
      ].join("\n");
      res.statusCode = 200;
      res.end(body);
      return;
    }
    if (req.method === "POST" && url === "/v1/chat/completions") {
      const body = await readBody(req);
      const payload = JSON.parse(body) as {
        slot_id?: number;
        messages: Array<{ content: string }>;
      };
      const slotId = typeof payload.slot_id === "number" ? payload.slot_id : -1;
      const promptText = payload.messages
        .map((m) => String(m.content ?? ""))
        .join("\n");
      // 1 token per word for the simulator. Realistic enough for cache
      // accounting; the actual number doesn't matter for these tests.
      const promptTokens = promptText.split(/\s+/).filter(Boolean).length;
      const cachedPrefix = state.prefixCachedTokensBySlot.get(slotId) ?? 0;
      // Whatever's longer than cachedPrefix has to be freshly prefilled.
      const freshTokens = Math.max(0, promptTokens - cachedPrefix);
      const cacheHitTokens = promptTokens - freshTokens;
      state.freshPrefillBySlot.set(
        slotId,
        (state.freshPrefillBySlot.get(slotId) ?? 0) + freshTokens,
      );
      state.cacheHitsBySlot.set(
        slotId,
        (state.cacheHitsBySlot.get(slotId) ?? 0) + cacheHitTokens,
      );
      // The whole prompt is now cached for this slot's next call.
      state.prefixCachedTokensBySlot.set(slotId, promptTokens);
      state.promptTokensTotal += promptTokens;
      state.promptTokensProcessedTotal += freshTokens;
      const completionTokens = 10;
      state.predictedTokensTotal += completionTokens;
      // Pretend speculative decoding ran when slot is warm.
      if (cacheHitTokens > 0) {
        state.draftedTotal += 16;
        state.acceptedTotal += 12;
      }
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: `mock-response slot=${slotId} fresh=${freshTokens} hit=${cacheHitTokens}`,
              },
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
          },
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      /^\/slots\/\d+\?action=(save|restore)$/.test(url)
    ) {
      const slotIdMatch = url.match(/^\/slots\/(\d+)\?action=(\w+)$/);
      if (slotIdMatch) {
        const slotId = Number(slotIdMatch[1]);
        const action = slotIdMatch[2] ?? "";
        state.slotEvents.push(`${action}:${slotId}`);
        const body = await readBody(req);
        let filename: string | undefined;
        try {
          const parsed = JSON.parse(body) as { filename?: string };
          filename = parsed.filename;
        } catch {
          // Mock tolerates an empty body — older test paths may not send one
        }
        if (action === "save" && filename) {
          // Touch the file the dflash-server expects to find on restore.
          fs.writeFileSync(path.join(slotDir, filename), `slot=${slotId}`);
        }
        if (action === "restore") {
          // Synthetic restore: assume previously-saved prefix had 4000 tokens.
          state.prefixCachedTokensBySlot.set(slotId, 4000);
        }
      }
      res.statusCode = 200;
      res.end("{}");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Patch the singleton dflashLlamaServer to point at our mock without
 * actually spawning a child process. Returns a restore function.
 */
function patchDflashServer(baseUrl: string, slotDir: string): () => void {
  const target = dflashLlamaServer as unknown as {
    baseUrl: string | null;
    child: object | null;
    cacheParallel: number;
    loadedPlan: object | null;
    cacheModelHash: string | null;
    cacheSlotDir: string | null;
    conversationKvDir: string | null;
  };
  const prev = {
    baseUrl: target.baseUrl,
    child: target.child,
    cacheParallel: target.cacheParallel,
    loadedPlan: target.loadedPlan,
    cacheModelHash: target.cacheModelHash,
    cacheSlotDir: target.cacheSlotDir,
    conversationKvDir: target.conversationKvDir,
  };
  // child is just truthy for hasLoadedModel(); we set a sentinel object
  target.child = { mock: true };
  target.baseUrl = baseUrl;
  target.cacheParallel = 4;
  target.loadedPlan = {
    targetModelPath: "/mock/target.gguf",
    drafterModelPath: "/mock/drafter.gguf",
    contextSize: 8192,
    draftContextSize: 4096,
    draftMin: 1,
    draftMax: 8,
    gpuLayers: 99,
    draftGpuLayers: 99,
    disableThinking: true,
  };
  target.cacheModelHash = "mock-hash";
  target.cacheSlotDir = slotDir;
  target.conversationKvDir = slotDir;
  return () => {
    target.baseUrl = prev.baseUrl;
    target.child = prev.child;
    target.cacheParallel = prev.cacheParallel;
    target.loadedPlan = prev.loadedPlan;
    target.cacheModelHash = prev.cacheModelHash;
    target.cacheSlotDir = prev.cacheSlotDir;
    target.conversationKvDir = prev.conversationKvDir;
  };
}

/**
 * Patch the dispatcher's active backend so the engine routes to dflash
 * without going through real load() (which would try to spawn the
 * binary).
 */
function patchEngineActiveBackend(engine: LocalInferenceEngine): () => void {
  const target = engine as unknown as {
    dispatcher: {
      active: { id: string } | null;
      activeBackendId: () => string | null;
    };
  };
  const prev = target.dispatcher.active;
  target.dispatcher.active = dflashLlamaServer as unknown as { id: string };
  return () => {
    target.dispatcher.active = prev;
  };
}

let mock: { baseUrl: string; close: () => Promise<void> } | null = null;
let restoreServer: () => void = () => {};
let restoreEngine: () => void = () => {};
let state: MockState = newMockState();
let engine: LocalInferenceEngine;
let slotDir: string = "";

beforeAll(async () => {
  state = newMockState();
  slotDir = fs.mkdtempSync(path.join(os.tmpdir(), "dflash-cache-flow-"));
  mock = await startMockServer(state, slotDir);
  restoreServer = patchDflashServer(mock.baseUrl, slotDir);
  engine = new LocalInferenceEngine();
  restoreEngine = patchEngineActiveBackend(engine);
});

afterAll(async () => {
  restoreEngine();
  restoreServer();
  await mock?.close();
  if (slotDir) fs.rmSync(slotDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset just the state, not the mock server — keep the same port across
  // the test file so the patched baseUrl stays valid.
  state.freshPrefillBySlot.clear();
  state.cacheHitsBySlot.clear();
  state.slotEvents.length = 0;
  state.promptTokensTotal = 0;
  state.promptTokensProcessedTotal = 0;
  state.predictedTokensTotal = 0;
  state.draftedTotal = 0;
  state.acceptedTotal = 0;
  state.prefixCachedTokensBySlot.clear();
});

afterEach(() => {
  // Drop every handle so each test starts clean. Eviction-based cleanup
  // is fine in production but flaky to rely on across tests.
  for (const handle of conversationRegistry.snapshot()) {
    conversationRegistry.close(handle.conversationId, handle.modelId);
  }
});

describe("conversation handle API: single conversation hits cache 95%+", () => {
  it("50-turn loop with 4k stable prefix reaches >= 95% hit rate", async () => {
    const handle = engine.openConversation({
      conversationId: "room-1",
      modelId: "mock-model",
    });

    // 4000-token "system + tools" stable prefix repeated every turn.
    const stablePrefix = Array.from({ length: 4000 }, (_, i) => `t${i}`).join(
      " ",
    );

    let totalCacheRead = 0;
    let totalInput = 0;

    for (let turn = 0; turn < 50; turn += 1) {
      const newWords = `turn-${turn} hello world ${turn * 13}`;
      const prompt = `${stablePrefix} ${newWords}`;
      const result = await engine.generateInConversation(handle, {
        prompt,
        maxTokens: 32,
      });
      totalCacheRead += result.usage.cache_read_input_tokens;
      totalInput += result.usage.input_tokens;
      // Every turn should land on the same slot.
      expect(result.slotId).toBe(handle.slotId);
    }

    const hitRate = totalCacheRead / totalInput;
    // Surface the measured hit rate so a human can see the actual number
    // — the 95% threshold is a hard floor, but reporting helps tune.
    // eslint-disable-next-line no-console
    console.log(
      `[dflash-cache-flow] 50-turn hit rate=${(hitRate * 100).toFixed(2)}% (cache_read=${totalCacheRead}/input=${totalInput})`,
    );
    expect(hitRate).toBeGreaterThanOrEqual(0.95);
  });

  it("two concurrent conversations land on distinct slots", async () => {
    const a = engine.openConversation({
      conversationId: "room-A",
      modelId: "mock-model",
    });
    const b = engine.openConversation({
      conversationId: "room-B",
      modelId: "mock-model",
    });
    expect(a.slotId).not.toBe(b.slotId);

    // Each conversation has its own 4k prefix.
    const prefixA = Array.from({ length: 4000 }, (_, i) => `a${i}`).join(" ");
    const prefixB = Array.from({ length: 4000 }, (_, i) => `b${i}`).join(" ");

    for (let turn = 0; turn < 10; turn += 1) {
      const ra = await engine.generateInConversation(a, {
        prompt: `${prefixA} turn-${turn}`,
      });
      const rb = await engine.generateInConversation(b, {
        prompt: `${prefixB} turn-${turn}`,
      });
      expect(ra.slotId).toBe(a.slotId);
      expect(rb.slotId).toBe(b.slotId);
      // From turn 1 onwards both should be hitting their warm slot.
      if (turn > 0) {
        expect(ra.usage.cache_read_input_tokens).toBeGreaterThan(0);
        expect(rb.usage.cache_read_input_tokens).toBeGreaterThan(0);
      }
    }
  });

  it("multi-conversation: 10 concurrent conversations, each maintains its slot", async () => {
    const handles = Array.from({ length: 10 }, (_, i) =>
      engine.openConversation({
        conversationId: `room-${i}`,
        modelId: "mock-model",
      }),
    );
    // High-water mark should reflect 10 concurrent.
    expect(engine.conversationHighWaterMark()).toBeGreaterThanOrEqual(10);
    // With parallel=4, some collisions are inevitable — but each
    // conversation must consistently land on the slot it was assigned.
    const recordedSlots = new Map<string, number>();
    for (const handle of handles) {
      const result = await engine.generateInConversation(handle, {
        prompt: `prefix-${handle.conversationId} hello`,
      });
      recordedSlots.set(handle.conversationId, result.slotId);
    }
    // Second pass: every conversation lands on the SAME slot it had before.
    for (const handle of handles) {
      const result = await engine.generateInConversation(handle, {
        prompt: `prefix-${handle.conversationId} again`,
      });
      expect(result.slotId).toBe(recordedSlots.get(handle.conversationId));
    }
  });
});

describe("prewarmConversation → first real request hits cache", () => {
  it("pre-warming the stable prefix makes the first generate a cache hit", async () => {
    const handle = engine.openConversation({
      conversationId: "prewarm-room",
      modelId: "mock-model",
    });

    // 4000-token stable prefix (system + tools + provider blocks).
    const stablePrefix = Array.from({ length: 4000 }, (_, i) => `p${i}`).join(
      " ",
    );

    // Pre-warm the slot with the stable prefix BEFORE any real request.
    const warmed = await engine.prewarmConversation(handle, stablePrefix);
    expect(warmed).toBe(true);

    // First real request appends the user turn to the same prefix. Because
    // the prefix is already cached on this slot, only the user tokens are
    // freshly prefilled.
    const result = await engine.generateInConversation(handle, {
      prompt: `${stablePrefix} hello there what is up`,
    });
    expect(result.slotId).toBe(handle.slotId);
    expect(result.usage.cache_read_input_tokens).toBeGreaterThanOrEqual(4000);
    // The fresh-prefill portion is just the appended user words (~5 tokens).
    expect(result.usage.cache_creation_input_tokens).toBeLessThan(50);
  });

  it("prewarmConversation by room id resolves a handle on the current model", async () => {
    // The string overload opens (or reuses) a handle keyed on the engine's
    // current model path — with the patched engine that's "/mock/target.gguf".
    const warmed = await engine.prewarmConversation(
      "prewarm-by-id-room",
      "system you are helpful and concise",
    );
    expect(warmed).toBe(true);
    const modelId = engine.currentModelPath() ?? "default-local-model";
    const handle = engine.conversation("prewarm-by-id-room", modelId);
    expect(handle).not.toBeNull();
  });
});

describe("KV save/restore across process restarts", () => {
  it("close persists; reopen + first generate restores", async () => {
    const handle = engine.openConversation({
      conversationId: "persistent-room",
      modelId: "mock-model",
    });

    // First turn: cold
    const first = await engine.generateInConversation(handle, {
      prompt: "system you are helpful",
    });
    expect(first.usage.cache_read_input_tokens).toBe(0);

    // Close → expects a save event for this slot
    await engine.closeConversation(handle);
    const savedEvents = state.slotEvents.filter((e) => e.startsWith("save:"));
    expect(savedEvents.length).toBeGreaterThan(0);

    // Simulate process restart: clear the in-RAM cache so the only way to
    // get back to a warm slot is via the restore path.
    state.prefixCachedTokensBySlot.clear();

    // Reopen — this triggers a lazy restore via openConversation
    const reopened = engine.openConversation({
      conversationId: "persistent-room",
      modelId: "mock-model",
    });
    // openConversation fires off the restore; it's async (fire-and-forget),
    // so we drain the microtask queue + give the HTTP roundtrip a window
    // to complete before asserting on the event log.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (state.slotEvents.some((e) => e.startsWith("restore:"))) break;
    }
    const restoredEvents = state.slotEvents.filter((e) =>
      e.startsWith("restore:"),
    );
    expect(restoredEvents.length).toBeGreaterThan(0);

    // First generate after restore should hit cache (mock simulates 4k
    // tokens of restored prefix).
    const second = await engine.generateInConversation(reopened, {
      prompt: Array.from({ length: 4500 }, (_, i) => `t${i}`).join(" "),
    });
    expect(second.usage.cache_read_input_tokens).toBeGreaterThan(0);
  });
});

describe("usage block matches Anthropic shape", () => {
  it("returns input_tokens, output_tokens, cache_creation, cache_read", async () => {
    const handle = engine.openConversation({
      conversationId: "shape-test",
      modelId: "mock-model",
    });
    const result = await engine.generateInConversation(handle, {
      prompt: "hello world",
    });
    expect(result.usage).toMatchObject({
      input_tokens: expect.any(Number),
      output_tokens: expect.any(Number),
      cache_creation_input_tokens: expect.any(Number),
      cache_read_input_tokens: expect.any(Number),
    });
  });

  it("includes dflash_acceptance_rate when speculative decoding ran", async () => {
    const handle = engine.openConversation({
      conversationId: "dflash-test",
      modelId: "mock-model",
    });
    // Cold first call — no draft yet
    await engine.generateInConversation(handle, { prompt: "cold call" });
    // Second call hits cache, mock simulates draft activity
    const warm = await engine.generateInConversation(handle, {
      prompt: "cold call again",
    });
    expect(warm.usage.dflash_drafted_tokens).toBeGreaterThan(0);
    expect(warm.usage.dflash_acceptance_rate).toBeDefined();
    expect(warm.usage.dflash_acceptance_rate ?? -1).toBeGreaterThan(0);
    expect(warm.usage.dflash_acceptance_rate ?? -1).toBeLessThanOrEqual(1);
  });
});
