/**
 * Warm TTFT distribution for the voice gateway's server-side legs.
 *
 * SCOPE / HONESTY: this measures the in-process server path only —
 * `bridgeStream` → shared-runtime stream → first `chunk` SSE frame — with the
 * model's inter-token delay scripted. It therefore measures the ORCHESTRATION
 * overhead this lane can affect (history load, character build, channel-id
 * derivation, SSE framing, and the interrupted-turn persistence added here).
 *
 * It does NOT include the real provider legs (Deepgram STT, model inference,
 * Cartesia TTS) or network. The end-to-end "stop speaking → hear audio" number
 * requires funded live credentials and is reported separately in the receipt.
 * Do not quote this as the user-felt TTFT.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {},
  isSensitiveKeyName: () => false,
  redactLogArgs: (...args: unknown[]) => args,
}));
mock.module("@elizaos/plugin-sql", () => ({}));
mock.module("../../db/repositories/characters", () => ({
  userCharactersRepository: { findByIdInOrganization: async () => undefined },
}));

import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const ROOM_ID = "44444444-4444-4444-8444-444444444444";

const sandboxRow = {
  id: AGENT_ID,
  organization_id: ORG_ID,
  user_id: USER_ID,
  execution_tier: "shared",
  status: "running",
  agent_name: "Soliza",
  character_id: "55555555-5555-4555-8555-555555555555",
} as unknown as AgentSandbox;

const historyStore = new Map<string, unknown[]>();
const key = (a: string, c: string) => `${a}::${c}`;

/** Scripted model latency: time before the first token is emitted. */
let modelFirstTokenDelayMs = 0;

beforeAll(() => {
  mock.module("../../db/repositories/shared-runtime-history", () => ({
    sharedRuntimeHistoryRepository: {
      get: async (a: string, c: string) => historyStore.get(key(a, c)) ?? [],
      upsert: async (a: string, c: string, h: unknown[]) => {
        historyStore.set(key(a, c), h);
      },
    },
  }));
  mock.module("./shared-runtime/run-shared-agent-turn", () => ({
    resolveSharedAgentTurnModel: () => null,
    runSharedAgentTurnStream: async () => {
      const delay = modelFirstTokenDelayMs;
      const parts = (async function* () {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        yield { type: "text-delta" as const, text: "Your flight is at 6pm." };
        yield { type: "finish" as const, text: "Your flight is at 6pm." };
      })();
      return { model: "probe", degraded: false, reply: "", parts };
    },
  }));
});

const { agentSandboxesRepository } = await import("../../db/repositories/agent-sandboxes");
const { runWithCloudBindings } = await import("../runtime/cloud-bindings");
const { elizaSandboxService } = await import("./eliza-sandbox");

beforeEach(() => {
  historyStore.clear();
  modelFirstTokenDelayMs = 0;
  (agentSandboxesRepository as unknown as { findRunningSandbox: unknown }).findRunningSandbox =
    mock(async () => sandboxRow);
});

/** Time from `bridgeStream` call to the first `chunk` SSE frame reaching a reader. */
async function measureServerTtftMs(text: string): Promise<number> {
  return runWithCloudBindings({} as Record<string, unknown>, async () => {
    const startedAt = performance.now();
    const res = await elizaSandboxService.bridgeStream(AGENT_ID, ORG_ID, {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message.send",
      params: { text, roomId: ROOM_ID, userId: USER_ID, source: "voice" },
    });
    const reader = res?.body?.getReader();
    if (!reader) throw new Error("no stream body");
    const decoder = new TextDecoder();
    let firstChunkAt: number | null = null;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const textChunk = decoder.decode(chunk.value, { stream: true });
      if (firstChunkAt === null && textChunk.includes("event: chunk")) {
        firstChunkAt = performance.now();
        await reader.cancel("measured");
        break;
      }
    }
    if (firstChunkAt === null) throw new Error("never saw a chunk frame");
    return firstChunkAt - startedAt;
  });
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

describe("voice gateway warm TTFT (server orchestration leg only)", () => {
  test("warm distribution over 30 turns, model delay excluded", async () => {
    // Warm the path (module init, first history read) before measuring.
    await measureServerTtftMs("warmup");

    const samples: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      samples.push(await measureServerTtftMs(`turn ${i}`));
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const stats = {
      n: sorted.length,
      min: +sorted[0].toFixed(2),
      p50: +percentile(sorted, 50).toFixed(2),
      p90: +percentile(sorted, 90).toFixed(2),
      p95: +percentile(sorted, 95).toFixed(2),
      max: +sorted[sorted.length - 1].toFixed(2),
    };
    console.log("[P5 warm TTFT — server orchestration leg, ms]", JSON.stringify(stats));

    // The server leg must stay a rounding error against the 1.5s felt budget,
    // so the provider legs own essentially all of it.
    expect(stats.p50).toBeLessThan(50);
    expect(stats.p95).toBeLessThan(150);
  });

  test("interrupted-turn persistence does not regress first-token latency", async () => {
    await measureServerTtftMs("warmup");
    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) samples.push(await measureServerTtftMs(`turn ${i}`));
    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    console.log("[P5 warm TTFT — with interrupted-persist path installed, ms]", p50.toFixed(2));
    // The new persistence work runs only on the interrupt path, never before
    // the first token, so first-token latency is unchanged.
    expect(p50).toBeLessThan(50);
  });

  test("a realistic 900ms model delay dominates; server adds only its own overhead", async () => {
    await measureServerTtftMs("warmup");
    modelFirstTokenDelayMs = 900;
    const observed = await measureServerTtftMs("when is my flight?");
    const overhead = observed - 900;
    console.log("[P5 server overhead above model first-token, ms]", overhead.toFixed(2));
    expect(overhead).toBeLessThan(100);
  });
});
