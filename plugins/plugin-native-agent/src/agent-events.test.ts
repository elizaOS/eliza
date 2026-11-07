/** Contract tests for the app-side IPC agent-event feed client. */
import { describe, expect, it, vi } from "vitest";
import { subscribeAgentEvents, supportsAgentEvents } from "./agent-events";
import type { AgentEventFeedEvent } from "./definitions";

function fakeAgent(opts: { reject?: boolean; earlyEvents?: boolean } = {}) {
  const listeners = new Set<(event: AgentEventFeedEvent) => void>();
  const emit = (event: AgentEventFeedEvent) => {
    for (const l of [...listeners]) l(event);
  };
  const agent = {
    subscribeEvents: vi.fn(
      async (o: { streams: string[]; subscriptionId?: string }) => {
        if (opts.reject) throw new Error("Too many event subscriptions");
        const id = o.subscriptionId as string;
        if (opts.earlyEvents) {
          emit({ subscriptionId: id, type: "subscribed", streams: o.streams });
          emit({ subscriptionId: id, type: "event", event: envelope("early") });
        }
        return { subscriptionId: id };
      },
    ),
    unsubscribeEvents: vi.fn(async () => ({ ok: true })),
    addListener: vi.fn(
      async (_name: "agentEvent", l: (e: AgentEventFeedEvent) => void) => {
        listeners.add(l);
        return {
          remove: async () => {
            listeners.delete(l);
          },
        };
      },
    ),
  };
  return { agent, emit, listeners };
}

function envelope(text: string, stream = "voice-transcript") {
  return {
    type: "agent_event" as const,
    version: 1 as const,
    eventId: "eph-1",
    ts: 1,
    runId: "voice-transcript:s1",
    seq: 1,
    stream,
    payload: { type: "voice-transcript", phase: "partial", text },
    ephemeral: true as const,
  };
}

describe("subscribeAgentEvents", () => {
  it("reports unsupported platforms", async () => {
    expect(supportsAgentEvents({})).toBe(false);
    await expect(
      subscribeAgentEvents(
        {},
        { streams: ["voice-transcript"] },
        {
          onEvent: () => {},
        },
      ),
    ).rejects.toThrow("unavailable");
  });

  it("delivers matching events for its own id, including those before the ack", async () => {
    const { agent, emit } = fakeAgent({ earlyEvents: true });
    const seen: string[] = [];
    const sub = await subscribeAgentEvents(
      agent,
      { streams: ["voice-transcript"] },
      { onEvent: (e) => seen.push(String(e.payload.text)) },
    );
    expect(agent.subscribeEvents).toHaveBeenCalledWith({
      streams: ["voice-transcript"],
      subscriptionId: sub.subscriptionId,
    });
    emit({
      subscriptionId: "other-subscription",
      type: "event",
      event: envelope("foreign"),
    });
    emit({
      subscriptionId: sub.subscriptionId,
      type: "event",
      event: envelope("tool", "tool"),
    });
    emit({
      subscriptionId: sub.subscriptionId,
      type: "event",
      event: envelope("hello"),
    });
    expect(seen).toEqual(["early", "hello"]);
    await sub.close();
    expect(await sub.ended).toBeUndefined();
  });

  it("ends exactly once with the agent's error and detaches", async () => {
    const { agent, emit, listeners } = fakeAgent();
    const onEnd = vi.fn();
    const onDropped = vi.fn();
    const sub = await subscribeAgentEvents(
      agent,
      { streams: ["voice-transcript"] },
      {
        onEvent: () => {
          throw new Error("handler bug");
        },
        onDropped,
        onEnd,
      },
    );
    emit({
      subscriptionId: sub.subscriptionId,
      type: "event",
      event: envelope("x"),
    });
    emit({ subscriptionId: sub.subscriptionId, type: "dropped", count: 2 });
    emit({
      subscriptionId: sub.subscriptionId,
      type: "end",
      error: "Unauthorized",
    });
    emit({ subscriptionId: sub.subscriptionId, type: "end", error: "again" });
    expect(onDropped).toHaveBeenCalledWith(2);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(await sub.ended).toBe("Unauthorized");
    await vi.waitFor(() => expect(listeners.size).toBe(0));
  });

  it("abort signal closes the feed; native refusal rejects and cleans up", async () => {
    const { agent, listeners } = fakeAgent();
    const controller = new AbortController();
    const sub = await subscribeAgentEvents(
      agent,
      { streams: ["voice-transcript"], signal: controller.signal },
      { onEvent: () => {} },
    );
    controller.abort();
    expect(await sub.ended).toBeUndefined();
    expect(agent.unsubscribeEvents).toHaveBeenCalledWith({
      subscriptionId: sub.subscriptionId,
    });
    const refused = fakeAgent({ reject: true });
    await expect(
      subscribeAgentEvents(
        refused.agent,
        { streams: ["voice-transcript"] },
        {
          onEvent: () => {},
        },
      ),
    ).rejects.toThrow("Too many");
    await vi.waitFor(() => expect(refused.listeners.size).toBe(0));
    await vi.waitFor(() => expect(listeners.size).toBe(0));
  });
  it("reports failed native cleanup instead of a successful close", async () => {
    const { agent } = fakeAgent();
    agent.unsubscribeEvents.mockRejectedValue(new Error("bridge unavailable"));
    const onEnd = vi.fn();
    const sub = await subscribeAgentEvents(
      agent,
      { streams: ["voice-transcript"] },
      { onEvent() {}, onEnd },
    );
    const first = sub.close();
    const second = sub.close();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow("bridge unavailable");
    expect(await sub.ended).toContain("cleanup is unconfirmed");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(agent.unsubscribeEvents).toHaveBeenCalledTimes(1);
  });

  it("does not let cancellation overtake native subscription registration", async () => {
    const { agent } = fakeAgent();
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    agent.subscribeEvents.mockImplementation(async ({ subscriptionId }) => {
      await ready;
      if (!subscriptionId) throw new Error("Missing subscription id");
      return { subscriptionId };
    });
    const controller = new AbortController();
    const pending = subscribeAgentEvents(
      agent,
      { streams: ["voice-transcript"], signal: controller.signal },
      { onEvent() {} },
    );
    await vi.waitFor(() =>
      expect(agent.subscribeEvents).toHaveBeenCalledTimes(1),
    );
    controller.abort();
    expect(agent.unsubscribeEvents).not.toHaveBeenCalled();
    release();
    const sub = await pending;
    expect(await sub.ended).toBeUndefined();
    expect(agent.unsubscribeEvents).toHaveBeenCalledTimes(1);
  });
});
