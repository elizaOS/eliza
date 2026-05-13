/**
 * Shared helpers for local-inference cache stress tests.
 *
 * These tests patch the dflashLlamaServer singleton with a mock HTTP server
 * (same pattern as `dflash-cache-flow.test.ts`) so we exercise real
 * production code in cache-bridge / conversation-registry / engine without
 * spawning the real `llama-server` binary.
 */

import fs from "node:fs";
import { vi } from "vitest";
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

function readFetchBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return "";
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
  vi.stubGlobal(
    "fetch",
    vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      handleMockFetch(input, init, state, slotDir),
    ),
  );
  return {
    baseUrl: "http://dflash-cache-stress.test",
    close: async () => {
      vi.unstubAllGlobals();
    },
  };
}

function handleMockFetch(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  state: MockState,
  slotDir: string,
): Response {
  const rawUrl =
    typeof input === "string" || input instanceof URL ? input : input.url;
  const url = new URL(rawUrl);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET") return handleMockGet(url, state);
  if (method === "POST" && url.pathname === "/v1/chat/completions") {
    return handleMockChatCompletion(init, state);
  }
  if (method === "POST" && /^\/slots\/\d+$/.test(url.pathname)) {
    return handleMockSlotRequest(url, init, state, slotDir);
  }
  return new Response(null, { status: 404 });
}

function handleMockGet(url: URL, state: MockState): Response {
  if (url.pathname === "/health") return Response.json({ status: "ok" });
  if (url.pathname === "/v1/models") {
    return Response.json({ data: [{ id: "mock" }] });
  }
  if (url.pathname !== "/metrics") return new Response(null, { status: 404 });
  const body = [
    `llamacpp:prompt_tokens_total ${state.promptTokensTotal}`,
    `llamacpp:n_tokens_predicted_total ${state.predictedTokensTotal}`,
    `llamacpp:n_prompt_tokens_processed_total ${state.promptTokensProcessedTotal}`,
    `llamacpp:n_drafted_total ${state.draftedTotal}`,
    `llamacpp:n_accepted_total ${state.acceptedTotal}`,
    `llamacpp:kv_cache_tokens 0`,
    `llamacpp:kv_cache_used_cells 0`,
  ].join("\n");
  return new Response(body, { status: 200 });
}

function handleMockChatCompletion(
  init: RequestInit | undefined,
  state: MockState,
): Response {
  const payload = JSON.parse(readFetchBody(init)) as {
    slot_id?: number;
    messages: Array<{ content: string }>;
  };
  const slotId = typeof payload.slot_id === "number" ? payload.slot_id : -1;
  const promptText = payload.messages
    .map((m) => String(m.content ?? ""))
    .join("\n");
  const promptTokenList = promptText.split(/\s+/).filter(Boolean);
  const promptTokens = promptTokenList.length;
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
  state.draftedTotal += 16;
  state.acceptedTotal += 12;
  return Response.json({
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
  });
}

function handleMockSlotRequest(
  url: URL,
  init: RequestInit | undefined,
  state: MockState,
  slotDir: string,
): Response {
  const slotIdMatch = url.pathname.match(/^\/slots\/(\d+)$/);
  if (!slotIdMatch) return Response.json({});
  const slotId = Number(slotIdMatch[1]);
  const action = url.searchParams.get("action") ?? "";
  state.slotEvents.push(`${action}:${slotId}`);
  const filename = readMockSlotFilename(init);
  if (action === "save" && filename) {
    const payload = `slot=${slotId}\nprefix-tokens=4000\n`;
    fs.writeFileSync(`${slotDir}/${filename}`, payload);
    state.slotSaveBytes += payload.length;
  }
  if (action === "restore" && !state.corruptRestore) {
    state.prefixCachedTokensBySlot.set(slotId, 4000);
    touchSlotLru(state, slotId);
  }
  if (action === "restore" && state.corruptRestore) {
    return Response.json({ error: "corrupt" }, { status: 500 });
  }
  return Response.json({});
}

function readMockSlotFilename(
  init: RequestInit | undefined,
): string | undefined {
  try {
    const parsed = JSON.parse(readFetchBody(init)) as { filename?: string };
    return parsed.filename;
  } catch {
    return undefined;
  }
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
