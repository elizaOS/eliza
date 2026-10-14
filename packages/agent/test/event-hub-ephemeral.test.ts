/** Ephemeral agent events (interim voice transcripts) reach live sockets but never the replay buffer. */
import { expect, it } from "vitest";
import {
  buildEphemeralAgentEventEnvelope,
  createApiEventHub,
  EPHEMERAL_AGENT_EVENT_STREAMS,
  type EventSocket,
} from "../src/api/event-hub.ts";

class FakeSocket implements EventSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send(message: string): void {
    this.sent.push(message);
  }
  terminate(): void {
    this.readyState = 3;
  }
}

it("broadcasts voice-transcript envelopes without buffering them", () => {
  expect(EPHEMERAL_AGENT_EVENT_STREAMS.has("voice-transcript")).toBe(true);
  const socket = new FakeSocket();
  const state = { eventBuffer: [], nextEventId: 7 };
  const hub = createApiEventHub({
    state,
    clients: new Set([socket]),
    clientIds: new WeakMap(),
    activeConversations: new WeakMap(),
    reportSendError: () => {},
  });
  const envelope = buildEphemeralAgentEventEnvelope({
    type: "agent_event",
    ts: 1,
    runId: "voice-transcript:s1",
    seq: 2,
    stream: "voice-transcript",
    payload: {
      type: "voice-transcript",
      phase: "partial",
      sessionId: "s1",
      turnId: "vt-1",
      text: "hello",
      seq: 1,
    },
  });
  hub.broadcast(envelope);

  expect(state.eventBuffer).toHaveLength(0);
  expect(state.nextEventId).toBe(7);
  expect(socket.sent).toHaveLength(1);
  const frame = JSON.parse(socket.sent[0] ?? "{}");
  expect(frame).toMatchObject({
    type: "agent_event",
    version: 1,
    ephemeral: true,
    stream: "voice-transcript",
    payload: { phase: "partial", text: "hello" },
  });
  expect(frame.eventId).toMatch(/^eph-\d+$/);
  expect(frame.bufferSeq).toBeUndefined();
});
