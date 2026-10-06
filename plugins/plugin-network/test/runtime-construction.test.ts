/**
 * Real AgentRuntime construction, mirroring the Cloud shared runtime's
 * per-turn `createRuntime` (in-memory portable SQLite, assistant plugin with
 * actions stripped, a model plugin, skipMigrations). Verifies the Network
 * plugin registers through the genuine runtime and measures construction +
 * initialize time with and without it.
 */
import {
  AgentRuntime,
  ChannelType,
  type Memory,
  ModelType,
  type Plugin,
  stringToUuid,
} from "@elizaos/core";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite/portable";
import { describe, expect, it } from "vitest";
import { createNetworkEdgePlugin, InMemoryNetworkStore } from "../src/index.js";

const modelPlugin: Plugin = {
  name: "spike-model",
  description: "never called",
  models: {
    [ModelType.TEXT_SMALL]: async () => {
      throw new Error("no inference in construction test");
    },
    [ModelType.TEXT_LARGE]: async () => {
      throw new Error("no inference in construction test");
    },
  },
};

function store() {
  return new InMemoryNetworkStore([
    {
      memberId: "mem_ada",
      firstName: "Ada",
      city: "San Francisco",
      state: "open",
      stateUntil: null,
      facets: ["climbs"],
      activeItems: [],
    },
  ]);
}

async function buildRuntime(withNetwork: boolean, key: string) {
  const assistant = createAssistantPlugin();
  const adapter = SQLiteDatabaseAdapter.create(":memory:", stringToUuid(key));
  const runtime = new AgentRuntime({
    agentId: stringToUuid(key),
    character: {
      name: "The Network",
      system: "You are The Network.",
      bio: [],
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      plugins: [],
      settings: {
        ELIZA_CANONICAL_LLM_TEXT_ENABLED: true,
        ELIZA_CANONICAL_EMBEDDINGS_ENABLED: false,
      },
    },
    adapter,
    plugins: [
      modelPlugin,
      { ...assistant, actions: [] },
      ...(withNetwork
        ? [createNetworkEdgePlugin({ store: store(), authority: { memberId: "mem_ada" } })]
        : []),
    ],
    logLevel: "error",
  });
  await runtime.initialize({ skipMigrations: true });
  return runtime;
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p95(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

describe("plugin-network in a real AgentRuntime", () => {
  it("registers provider, action and evaluator; provider composes into state", async () => {
    const runtime = await buildRuntime(true, "network-spike-registration");
    try {
      expect(runtime.actions.map((a) => a.name)).toContain("SET_STATE");
      expect(runtime.providers.map((p) => p.name)).toContain("MEMBER_CONTEXT");
      expect(runtime.evaluators.map((e) => e.name)).toContain("NETWORK_SIGNALS");
      const roomId = stringToUuid("network-spike-room");
      const entityId = stringToUuid("network-spike-user");
      await runtime.ensureConnection({
        entityId,
        roomId,
        worldId: stringToUuid("network-spike-world"),
        userName: "Ada",
        source: "network-spike",
        type: ChannelType.DM,
      });
      const message: Memory = {
        id: stringToUuid("network-spike-msg-1"),
        entityId,
        roomId,
        agentId: runtime.agentId,
        content: { text: "I'm in Austin next week, mark me traveling" },
      };
      const state = await runtime.composeState(message, ["MEMBER_CONTEXT"], true);
      expect(state.text).toContain("Name: Ada (San Francisco)");
    } finally {
      await runtime.stop();
    }
  }, 120_000);

  it("measures runtime construction + initialize with and without the plugin", async () => {
    // Warm module graph once.
    await (await buildRuntime(false, "warm-a")).stop();
    await (await buildRuntime(true, "warm-b")).stop();
    const N = 15;
    const without: number[] = [];
    const withNet: number[] = [];
    for (let i = 0; i < N; i++) {
      for (const [flag, sink] of [
        [false, without],
        [true, withNet],
      ] as const) {
        const t0 = performance.now();
        const rt = await buildRuntime(flag, `m-${flag}-${i}`);
        sink.push(performance.now() - t0);
        await rt.stop();
      }
    }
    const report = {
      iterations: N,
      withoutPluginMs: { median: +median(without).toFixed(2), p95: +p95(without).toFixed(2) },
      withPluginMs: { median: +median(withNet).toFixed(2), p95: +p95(withNet).toFixed(2) },
      deltaMedianMs: +(median(withNet) - median(without)).toFixed(2),
    };
    console.log(`NETWORK_SPIKE_TIMING ${JSON.stringify(report)}`);
    expect(report.deltaMedianMs).toBeLessThan(50);
  }, 300_000);
});
