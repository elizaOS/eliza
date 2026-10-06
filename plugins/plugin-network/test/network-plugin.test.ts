/**
 * Unit tests for the Network spike plugin against the repo's mock runtime
 * (`createMockRuntime` from @elizaos/testing) and an in-memory NetworkStore.
 */
import type { HandlerOptions, Memory, State, UUID } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it } from "vitest";
import {
  createNetworkEdgePlugin,
  detectNetworkSignals,
  InMemoryNetworkStore,
  type NetworkMemberContext,
} from "../src/index.js";

const MEMBER: NetworkMemberContext = {
  memberId: "mem_ada",
  firstName: "Ada",
  city: "San Francisco",
  state: "open",
  stateUntil: null,
  facets: ["climbs at Mission Cliffs", "building a robotics startup"],
  activeItems: [{ kind: "invitation", summary: "Intro to Grace (climbing partner) awaiting reply" }],
};

const ROOM = "00000000-0000-0000-0000-0000000000cc" as UUID;
const ENTITY = "00000000-0000-0000-0000-0000000000aa" as UUID;

function msg(id: string, text: string): Memory {
  return {
    id: id as UUID,
    entityId: ENTITY,
    roomId: ROOM,
    agentId: "00000000-0000-0000-0000-000000000000" as UUID,
    content: { text },
  } as Memory;
}

function setup() {
  const store = new InMemoryNetworkStore([MEMBER], () => new Date("2026-10-06T12:00:00Z"));
  const plugin = createNetworkEdgePlugin({ store, authority: { memberId: "mem_ada" } });
  const runtime = createMockRuntime();
  return { store, plugin, runtime };
}

describe("plugin-network (spike)", () => {
  it("exposes exactly one provider, one action and one evaluator", () => {
    const { plugin } = setup();
    expect(plugin.name).toBe("network-edge");
    expect(plugin.providers?.map((p) => p.name)).toEqual(["MEMBER_CONTEXT"]);
    expect(plugin.actions?.map((a) => a.name)).toEqual(["SET_STATE"]);
    expect(plugin.evaluators?.map((e) => e.name)).toEqual(["NETWORK_SIGNALS"]);
  });

  it("registers zero actions for system/lifecycle turns", () => {
    const store = new InMemoryNetworkStore([MEMBER]);
    const plugin = createNetworkEdgePlugin({
      store,
      authority: { memberId: "mem_ada" },
      actionsEnabled: false,
    });
    expect(plugin.actions).toEqual([]);
  });

  it("MEMBER_CONTEXT renders the injected member", async () => {
    const { plugin, runtime } = setup();
    const provider = plugin.providers![0];
    const result = await provider.get(runtime, msg("m1", "hi"), {} as State);
    expect(result.text).toContain("Name: Ada (San Francisco)");
    expect(result.text).toContain("State: open");
    expect(result.text).toContain("climbs at Mission Cliffs");
    expect(result.text).toContain("[invitation] Intro to Grace");
    expect(result.values).toEqual({ networkMemberState: "open" });
  });

  it("MEMBER_CONTEXT returns empty text for an unknown member", async () => {
    const store = new InMemoryNetworkStore([]);
    const plugin = createNetworkEdgePlugin({ store, authority: { memberId: "nobody" } });
    const result = await plugin.providers![0].get(createMockRuntime(), msg("m1", "hi"), {} as State);
    expect(result.text).toBe("");
  });

  it("SET_STATE applies a durable change with an applied effect receipt", async () => {
    const { plugin, runtime, store } = setup();
    const action = plugin.actions![0];
    const options = {
      parameters: { state: "traveling", until: "2026-10-20", note: "in NYC for work" },
    } as HandlerOptions;
    const result = await action.handler(runtime, msg("m2", "I'm in NYC until the 20th"), undefined, options);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ actionName: "SET_STATE", previous: "open", current: "traveling" });
    expect(result.effectReceipts?.[0]).toMatchObject({
      operation: "network.set_state",
      outcome: "applied",
      resource: { kind: "network.member_state", id: "mem_ada" },
      commit: { kind: "durable" },
    });
    expect((await store.getMemberContext("mem_ada"))?.state).toBe("traveling");
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ type: "member.state_changed", memberId: "mem_ada" });
  });

  it("SET_STATE is idempotent per message and replays as a noop receipt", async () => {
    const { plugin, runtime, store } = setup();
    const action = plugin.actions![0];
    const options = { parameters: { state: "busy" } } as HandlerOptions;
    await action.handler(runtime, msg("m3", "swamped this week"), undefined, options);
    const replay = await action.handler(runtime, msg("m3", "swamped this week"), undefined, options);
    expect(replay.effectReceipts?.[0]).toMatchObject({ outcome: "noop", idempotency: { replayed: true } });
    expect(store.events).toHaveLength(1);
  });

  it("SET_STATE binds identity to host authority, ignoring model-supplied member ids", async () => {
    const store = new InMemoryNetworkStore([MEMBER, { ...MEMBER, memberId: "mem_eve", firstName: "Eve" }]);
    const plugin = createNetworkEdgePlugin({ store, authority: { memberId: "mem_ada" } });
    await plugin.actions![0].handler(createMockRuntime(), msg("m4", "pause"), undefined, {
      parameters: { state: "paused", memberId: "mem_eve" },
    } as HandlerOptions);
    expect((await store.getMemberContext("mem_ada"))?.state).toBe("paused");
    expect((await store.getMemberContext("mem_eve"))?.state).toBe("open");
  });

  it("SET_STATE rejects invalid parameters without writing", async () => {
    const { plugin, runtime, store } = setup();
    const r1 = await plugin.actions![0].handler(runtime, msg("m5", "x"), undefined, {
      parameters: { state: "invisible" },
    } as HandlerOptions);
    const r2 = await plugin.actions![0].handler(runtime, msg("m6", "x"), undefined, {
      parameters: { state: "busy", until: "not a date" },
    } as HandlerOptions);
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
    expect(store.events).toHaveLength(0);
  });

  it("NETWORK_SIGNALS detects signals deterministically and records them", async () => {
    const { plugin, runtime, store } = setup();
    const evaluator = plugin.evaluators![0];
    const message = msg("m7", "Honestly he made me uncomfortable. Also I'm in Austin next week");
    const ctx = { runtime, message, options: {} };
    expect(await evaluator.shouldRun(ctx)).toBe(true);
    const prepared = await evaluator.prepare!({ ...ctx, state: {} as State });
    const output = evaluator.resolveOutput!({ ...ctx, state: {} as State, prepared });
    expect(output).toEqual({
      signals: [
        { kind: "travel", evidence: "I'm in Austin next week" },
        { kind: "safety_concern", evidence: "made me uncomfortable" },
      ],
    });
    const result = await evaluator.processors![0].process({
      ...ctx,
      state: {} as State,
      prepared,
      output,
      evaluatorName: "NETWORK_SIGNALS",
    });
    expect(result?.data).toMatchObject({ recorded: 2 });
    expect(store.signals.map((s) => s.signal.kind)).toEqual(["travel", "safety_concern"]);
    expect(await evaluator.shouldRun({ runtime, message: msg("m8", "sounds good!"), options: {} })).toBe(false);
  });

  it("detectNetworkSignals ignores ordinary chat", () => {
    expect(detectNetworkSignals("want to grab coffee thursday?")).toEqual([]);
  });
});
