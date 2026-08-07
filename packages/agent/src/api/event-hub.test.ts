/** Tests buffered, broadcast, and targeted API event delivery without sockets. */
import { describe, expect, it, vi } from "vitest";
import { createApiEventHub, type EventSocket } from "./event-hub.ts";

interface TestSocket extends EventSocket {
  messages: string[];
}

function socket(): TestSocket {
  const messages: string[] = [];
  return {
    readyState: 1,
    messages,
    send(message) {
      messages.push(message);
    },
  };
}

describe("API event hub", () => {
  it("publishes monotonic buffered envelopes and evicts the oldest", () => {
    const client = socket();
    const state = { eventBuffer: [], nextEventId: 1 };
    const hub = createApiEventHub({
      state,
      clients: new Set([client]),
      clientIds: new WeakMap(),
      activeConversations: new WeakMap(),
      reportSendError: vi.fn(),
      maxBufferedEvents: 1,
    });
    hub.publish({ type: "agent_event", ts: 1, payload: { message: "first" } });
    hub.publish({ type: "agent_event", ts: 2, payload: { message: "second" } });
    expect(state.eventBuffer).toHaveLength(1);
    expect(state.eventBuffer[0]).toMatchObject({
      eventId: "evt-2",
      bufferSeq: 2,
    });
    expect(client.messages).toHaveLength(2);
  });

  it("targets client and conversation ownership independently", () => {
    const first = socket();
    const second = socket();
    const clientIds = new WeakMap<EventSocket, string>([[first, "first"]]);
    const conversations = new WeakMap<EventSocket, string>([
      [second, "conversation"],
    ]);
    const hub = createApiEventHub({
      state: { eventBuffer: [], nextEventId: 1 },
      clients: new Set([first, second]),
      clientIds,
      activeConversations: conversations,
      reportSendError: vi.fn(),
    });
    expect(hub.sendToClient("first", { ok: true })).toBe(1);
    expect(hub.sendToConversation("conversation", { ok: true })).toBe(1);
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
  });
});
