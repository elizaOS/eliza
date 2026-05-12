/**
 * Shared helpers for local-inference cache stress tests.
 *
 * These tests patch the dflashLlamaServer singleton with a mock HTTP server
 * (same pattern as `dflash-cache-flow.test.ts`) so we exercise real
 * production code in cache-bridge / conversation-registry / engine without
 * spawning the real `llama-server` binary.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dflashLlamaServer } from "../dflash-server";
import type { LocalInferenceEngine } from "../engine";

export interface MockState {
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
  /**
   * Synthetic radix tree: slot remembers its last cached token sequence.
   * The mock measures cache hit by computing the longest common prefix
   * between the new prompt's tokens and the slot's cached tokens —
   * mirroring llama-server's actual prefix-cache radix tree behaviour.
   */
  cachedTokensBySlot: Map<number, string[]>;
  /**
   * When set, the mock simulates slot eviction. With `parallel=N`, the
   * mock keeps only the N most recent slot prefixes warm; older slots get
   * evicted and cold-prefill on next use. This mirrors llama-server's
   * actual continuous-batching behaviour when more conversations exist
   * than slots.
   */
  parallelLimit?: number;
  /** Most-recently-touched slot id, head of the LRU list. */
  slotLru: number[];
  /** Optional hook to corrupt slot save/restore. */
  corruptRestore?: boolean;
  /** Total slot-save bytes written; tracks save volume across the run. */
  slotSaveBytes: number;
  /** Per-slot prefill token counter (telemetry the test inspects). */
  promptTokensBySlot: Map<number, number>;
}

export function newMockState(): MockState {
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
    cachedTokensBySlot: new Map(),
    slotLru: [],
    slotSaveBytes: 0,
    promptTokensBySlot: new Map(),
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

function touchSlotLru(state: MockState, slotId: number): void {
  const idx = state.slotLru.indexOf(slotId);
  if (idx >= 0) state.slotLru.splice(idx, 1);
  state.slotLru.push(slotId);
  if (state.parallelLimit && state.slotLru.length > state.parallelLimit) {
    const evicted = state.slotLru.shift();
    if (evicted !== undefined) {
      state.prefixCachedTokensBySlot.delete(evicted);
      state.cachedTokensBySlot.delete(evicted);
    }
  }
}

/** Length of the longest common prefix between two token arrays. */
function longestCommonPrefix(a: string[], b: string[]): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

export async function startMockServer(
  state: MockState,
  slotDir: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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
      const promptTokenList = promptText.split(/\s+/).filter(Boolean);
      const promptTokens = promptTokenList.length;
      // Realistic radix-tree behaviour: cache hit is the longest common
      // prefix between the new prompt and the slot's cached tokens.
      const cachedTokens = state.cachedTokensBySlot.get(slotId) ?? [];
      const cacheHitTokens = longestCommonPrefix(promptTokenList, cachedTokens);
      const freshTokens = promptTokens - cacheHitTokens;
      state.freshPrefillBySlot.set(
        slotId,
        (state.freshPrefillBySlot.get(slotId) ?? 0) + freshTokens,
      );
      state.cacheHitsBySlot.set(
        slotId,
        (state.cacheHitsBySlot.get(slotId) ?? 0) + cacheHitTokens,
      );
      state.prefixCachedTokensBySlot.set(slotId, promptTokens);
      state.cachedTokensBySlot.set(slotId, promptTokenList);
      state.promptTokensBySlot.set(
        slotId,
        (state.promptTokensBySlot.get(slotId) ?? 0) + promptTokens,
      );
      touchSlotLru(state, slotId);
      state.promptTokensTotal += promptTokens;
      state.promptTokensProcessedTotal += freshTokens;
      const completionTokens = 10;
      state.predictedTokensTotal += completionTokens;
      // DFlash drafts on every generation step regardless of prefix-cache
      // state; the extra acceptance on a warm cache is a separate bonus.
      state.draftedTotal += 16;
      state.acceptedTotal += cacheHitTokens > 0 ? 12 : 8;
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: `mock slot=${slotId} fresh=${freshTokens} hit=${cacheHitTokens}`,
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
          // Mock tolerates an empty body
        }
        if (action === "save" && filename) {
          // Realistic save: tag with slot id + a synthetic 4k-token marker
          const payload = `slot=${slotId}\nprefix-tokens=4000\n`;
          fs.writeFileSync(`${slotDir}/${filename}`, payload);
          state.slotSaveBytes += payload.length;
        }
        if (action === "restore" && !state.corruptRestore) {
          state.prefixCachedTokensBySlot.set(slotId, 4000);
          touchSlotLru(state, slotId);
        }
        if (action === "restore" && state.corruptRestore) {
          // Synthesise a 500 — this is what llama-server would return on
          // a malformed slot KV file in practice. Triggers the dflash
          // requestSlotRestore catch path which throws and the engine
          // swallows.
          res.statusCode = 500;
          res.end('{"error":"corrupt"}');
          return;
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

export interface DflashTarget {
  baseUrl: string | null;
  child: object | null;
  cacheParallel: number;
  loadedPlan: object | null;
  cacheModelHash: string | null;
  cacheSlotDir: string | null;
  conversationKvDir: string | null;
}

/**
 * Patch the dflashLlamaServer singleton with the mock HTTP base URL and
 * a fake child sentinel so `hasLoadedModel()` returns true. Returns a
 * restore function. Callers can pass `parallel` to set the slot count
 * the engine sees via `parallelSlots()`.
 */
export function patchDflashServer(
  baseUrl: string,
  slotDir: string,
  parallel = 4,
): () => void {
  const target = dflashLlamaServer as unknown as DflashTarget;
  const prev: DflashTarget = {
    baseUrl: target.baseUrl,
    child: target.child,
    cacheParallel: target.cacheParallel,
    loadedPlan: target.loadedPlan,
    cacheModelHash: target.cacheModelHash,
    cacheSlotDir: target.cacheSlotDir,
    conversationKvDir: target.conversationKvDir,
  };
  target.child = { mock: true };
  target.baseUrl = baseUrl;
  target.cacheParallel = parallel;
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
 * Patch the engine dispatcher so it routes generation through the
 * dflash-server backend without calling load() (which would try to spawn
 * the real binary).
 */
export function patchEngineActiveBackend(
  engine: LocalInferenceEngine,
): () => void {
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
