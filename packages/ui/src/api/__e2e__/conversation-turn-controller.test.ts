import { describe, expect, it } from "vitest";
import {
  type ConversationRoom,
  type ConversationTurnContext,
  ConversationTurnController,
  type ConversationTurnFailure,
  ConversationTurnRefusal,
  type ConversationTurnTransport,
  admitConversationStopReceipt,
  findStoppedUserTurn,
} from "../conversation-turn-controller";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const sends: Array<{
    room: ConversationRoom;
    input: string;
    turn: ConversationTurnContext;
    reply: Deferred<string>;
  }> = [];
  const stops: ConversationRoom[] = [];
  let stopResult: Deferred<unknown> | null = null;
  let created = 0;
  let ids = 0;
  const transport: ConversationTurnTransport<string, string> = {
    create: async () => ({
      id: `conversation-${++created}`,
      roomId: `room-${created}`,
    }),
    send: (room, input, turn) => {
      const reply = deferred<string>();
      sends.push({ room, input, turn, reply });
      return reply.promise;
    },
    stop: (room) => {
      stops.push(room);
      return stopResult ? stopResult.promise : Promise.resolve();
    },
    ownershipLost: (error) => (error as { status?: number })?.status === 404,
    clientMessageId: () => `client-${++ids}`,
  };
  const controller = new ConversationTurnController(transport);
  const events: string[] = [];
  const failures: ConversationTurnFailure[] = [];
  const refusals: ConversationTurnRefusal[] = [];
  const observer = {
    reply: (reply: string) => events.push(`reply:${reply}`),
    error: (error: unknown, failure?: ConversationTurnFailure) => {
      events.push(`error:${(error as Error).message}`);
      if (failure) failures.push(failure);
    },
    settled: () => events.push("settled"),
    refused: (refusal: ConversationTurnRefusal) => {
      events.push(`refused:${refusal.code}`);
      refusals.push(refusal);
    },
  };
  return {
    controller,
    sends,
    stops,
    events,
    failures,
    refusals,
    observer,
    blockStop: () => {
      stopResult = deferred<unknown>();
      return stopResult;
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ConversationTurnController", () => {
  it("retains a resident caller's request identity through send and Stop", async () => {
    const pending = deferred<string>();
    const requests: ConversationTurnContext[] = [];
    const controller = new ConversationTurnController<
      { requestId: string; text: string },
      string
    >({
      create: async () => ({ id: "conversation", roomId: "room" }),
      clientMessageId: (input) => input.requestId,
      send: async (_room, _input, turn) => {
        requests.push(turn);
        return pending.promise;
      },
      stop: async () => {},
      ownershipLost: () => false,
    });
    const sent = controller.send(
      { requestId: "voice-turn-from-resident", text: "hello" },
      { reply: () => {}, error: () => {}, settled: () => {} },
    );
    await tick();
    expect(requests[0].clientMessageId).toBe("voice-turn-from-resident");
    await controller.interrupt();
    expect(controller.stopped?.clientMessageId).toBe("voice-turn-from-resident");
    pending.resolve("late reply");
    expect(await sent).toBe(false);
  });

  it("sends one turn with a clientMessageId and publishes its reply", async () => {
    const h = harness();
    const sent = h.controller.send("hello", h.observer);
    await tick();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].turn.clientMessageId).toBe("client-1");
    expect(h.sends[0].room).toEqual({ id: "conversation-1", roomId: "room-1" });
    expect(Object.isFrozen(h.sends[0].room)).toBe(true);
    h.sends[0].reply.resolve("hi");
    expect(await sent).toBe(true);
    expect(h.events).toEqual(["reply:hi", "settled"]);
  });

  it("mints a v4 clientMessageId without randomUUID (plain-HTTP origin)", async () => {
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    try {
      let seen = "";
      const controller = new ConversationTurnController<string, string>({
        create: async () => ({ id: "c", roomId: "r" }),
        send: async (_room, _input, turn) => {
          seen = turn.clientMessageId;
          return "ok";
        },
        stop: async () => undefined,
        ownershipLost: () => false,
      });
      expect(
        await controller.send("hello", {
          reply: () => {},
          error: (error) => {
            throw error;
          },
          settled: () => {},
        }),
      ).toBe(true);
      expect(seen).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: original,
        configurable: true,
      });
    }
  });

  it("refuses a concurrent send with a typed busy refusal", async () => {
    const h = harness();
    void h.controller.send("first", h.observer);
    await tick();
    expect(await h.controller.send("second", h.observer)).toBe(false);
    expect(h.refusals.map((r) => r.code)).toEqual(["busy"]);
    expect(h.refusals[0]).toBeInstanceOf(ConversationTurnRefusal);
    expect(h.sends).toHaveLength(1);
  });

  it("never replays a dispatched write that failed", async () => {
    const h = harness();
    const sent = h.controller.send("save this", h.observer);
    await tick();
    h.sends[0].reply.reject(
      Object.assign(Error("stream lost"), { status: 502 }),
    );
    expect(await sent).toBe(false);
    expect(h.failures).toEqual([
      { dispatched: true, clientMessageId: "client-1" },
    ]);
    await tick();
    expect(h.sends).toHaveLength(1);
    // A later explicit send is a new turn with a new identity.
    void h.controller.send("save this", h.observer);
    await tick();
    expect(h.sends[1].turn.clientMessageId).toBe("client-2");
    expect(h.sends[1].room).toBe(h.sends[0].room);
  });

  it("interrupt drops the late reply, aborts the stream and records the stopped turn", async () => {
    const h = harness();
    const sent = h.controller.send("long answer", h.observer);
    await tick();
    const { turn } = h.sends[0];
    const stopped = h.controller.interrupt();
    expect(turn.signal.aborted).toBe(true);
    expect(turn.current()).toBe(false);
    expect(await stopped).toEqual({ status: "stopped" });
    expect(h.stops).toEqual([{ id: "conversation-1", roomId: "room-1" }]);
    expect(h.controller.stopped).toMatchObject({
      clientMessageId: "client-1",
      input: "long answer",
      conversation: { id: "conversation-1" },
    });
    h.sends[0].reply.resolve("too late");
    expect(await sent).toBe(false);
    expect(h.events).toEqual([]);
    h.controller.clearStopped("client-1");
    expect(h.controller.stopped).toBeNull();
  });

  it("waits for the remote stop before the next send (stop before replacement)", async () => {
    const h = harness();
    void h.controller.send("one", h.observer);
    await tick();
    const stop = h.blockStop();
    void h.controller.interrupt();
    const next = h.controller.send("two", h.observer);
    await tick();
    expect(h.sends).toHaveLength(1);
    stop.resolve(undefined);
    await tick();
    expect(h.sends).toHaveLength(2);
    h.sends[1].reply.resolve("ok");
    expect(await next).toBe(true);
  });

  it("refuses the next send when the stop was not confirmed and drops the binding", async () => {
    const h = harness();
    void h.controller.send("one", h.observer);
    await tick();
    const stop = h.blockStop();
    void h.controller.interrupt();
    const next = h.controller.send("two", h.observer);
    stop.reject(Error("abort route unavailable"));
    expect(await next).toBe(false);
    expect(h.refusals.map((r) => r.code)).toEqual(["stop-unconfirmed"]);
    expect(h.controller.conversation).toBeNull();
    // The refusal is consumed; a further explicit send opens a new conversation.
    void h.controller.send("three", h.observer);
    await tick();
    expect(h.sends.at(-1)?.room.id).toBe("conversation-2");
  });

  it("bind adopts a resident conversation and stops a dispatched turn in the old one", async () => {
    const h = harness();
    await h.controller.bind({ id: "resident", roomId: "resident-room" });
    const gen = h.controller.generation;
    const fence = h.controller.fence();
    const sent = h.controller.send("hello", h.observer);
    await tick();
    expect(h.sends[0].room).toEqual({
      id: "resident",
      roomId: "resident-room",
    });
    expect(h.sends[0].turn.generation).toBe(gen);
    const rebound = h.controller.bind({ id: "other", roomId: "other-room" });
    expect(h.controller.generation).toBe(gen + 1);
    expect(fence()).toBe(false);
    expect(await rebound).toEqual({ status: "stopped" });
    expect(h.stops).toEqual([{ id: "resident", roomId: "resident-room" }]);
    h.sends[0].reply.resolve("late");
    expect(await sent).toBe(false);
    expect(h.events).toEqual([]);
    // Rebinding the same identity changes nothing.
    await h.controller.bind({ id: "other", roomId: "other-room" });
    expect(h.controller.generation).toBe(gen + 1);
    expect(() => h.controller.bind({ id: "", roomId: "x" })).toThrow(
      ConversationTurnRefusal,
    );
  });

  it("reset fences callbacks and forgets the conversation", async () => {
    const h = harness();
    const sent = h.controller.send("hello", h.observer);
    await tick();
    await h.controller.reset();
    h.sends[0].reply.reject(Error("late failure"));
    expect(await sent).toBe(false);
    expect(h.events).toEqual([]);
    expect(h.controller.conversation).toBeNull();
    expect(h.controller.stopped).toBeNull();
  });

  it("clears the binding when the agent reports ownership lost", async () => {
    const h = harness();
    const sent = h.controller.send("hello", h.observer);
    await tick();
    h.sends[0].reply.reject(Object.assign(Error("gone"), { status: 404 }));
    await sent;
    expect(h.controller.conversation).toBeNull();
  });

  it("refuses an invalid created identity before dispatch", async () => {
    const controller = new ConversationTurnController<string, string>({
      create: async () => ({ id: " ", roomId: "room" }),
      send: async () => {
        throw Error("must not send");
      },
      stop: async () => {},
      ownershipLost: () => false,
    });
    const codes: string[] = [];
    let failure: ConversationTurnFailure | undefined;
    await controller.send("x", {
      reply: () => {},
      error: (error, f) => {
        codes.push((error as ConversationTurnRefusal).code);
        failure = f;
      },
      settled: () => {},
    });
    expect(codes).toEqual(["invalid-identity"]);
    expect(failure).toBeUndefined();
  });
});

describe("ConversationTurnController.request", () => {
  const room = { id: "bound", roomId: "bound-room" };

  it("uses the same controller for an awaited bound request", async () => {
    const h = harness();
    const reply = h.controller.request("hello", { conversation: room });
    await tick();
    expect(h.sends[0].room).toEqual(room);
    expect(h.sends[0].turn.clientMessageId).toBe("client-1");
    h.sends[0].reply.resolve("done");
    expect(await reply).toBe("done");
    expect(h.controller.pending).toBe(false);
  });

  it("keeps a dispatched AbortError's identity and does not mark it unsent", async () => {
    const h = harness();
    const failure = Object.assign(new DOMException("Stream dropped", "AbortError"), { notDispatched: true });
    const reply = h.controller.request("hello", { conversation: room });
    const rejected = expect(reply).rejects.toBe(failure);
    await tick();
    h.sends[0].reply.reject(failure);
    await rejected;
    expect(failure.notDispatched).toBe(false);
    expect(h.stops).toEqual([]);
  });

  it("keeps a creation error's identity and marks it unsent", async () => {
    const failure = new TypeError("Creation failed");
    const controller = new ConversationTurnController({
      create: async () => { throw failure; },
      send: async () => "unexpected",
      stop: async () => {},
      ownershipLost: () => false,
    });
    await expect(controller.request("hello")).rejects.toBe(failure);
    expect(failure).toMatchObject({ notDispatched: true });
  });

  it("declines a concurrent request without changing the binding or stopping its owner", async () => {
    const h = harness();
    const first = h.controller.request("first", { conversation: room });
    await tick();
    const signal = new AbortController();
    await expect(h.controller.request("second", {
      conversation: { id: "other", roomId: "other-room" }, signal: signal.signal,
    })).rejects.toMatchObject({ code: "busy", notDispatched: true });
    signal.abort();
    expect(h.controller.conversation).toEqual(room);
    expect(h.stops).toEqual([]);
    expect(h.sends).toHaveLength(1);
    h.sends[0].reply.resolve("first reply");
    expect(await first).toBe("first reply");
  });

  it("does not bind or create for an already-cancelled request", async () => {
    const h = harness();
    const abort = new AbortController(); abort.abort();
    await expect(h.controller.request("cancelled", { conversation: room, signal: abort.signal }))
      .rejects.toMatchObject({ name: "AbortError", notDispatched: true });
    expect(h.controller.conversation).toBeNull();
    expect(h.sends).toEqual([]);
    expect(h.stops).toEqual([]);
    expect(h.controller.generation).toBe(0);
  });

  it("settles local cancellation even if the transport never settles", async () => {
    const h = harness();
    const abort = new AbortController();
    const reply = h.controller.request("active", { conversation: room, signal: abort.signal });
    const rejected = expect(reply).rejects.toMatchObject({ name: "AbortError", notDispatched: false });
    await tick(); abort.abort(); await rejected;
    expect(h.sends[0].turn.signal.aborted).toBe(true);
    expect(h.stops).toEqual([room]);
  });

  it("never lets an old caller's cancellation interrupt its successor", async () => {
    const h = harness();
    const oldAbort = new AbortController();
    const first = h.controller.request("first", { conversation: room, signal: oldAbort.signal });
    await tick(); h.sends[0].reply.resolve("first done"); await first;
    const second = h.controller.request("second", { conversation: room });
    await tick(); oldAbort.abort();
    expect(h.stops).toEqual([]);
    expect(h.sends[1].turn.current()).toBe(true);
    expect(h.sends[1].turn.signal.aborted).toBe(false);
    h.sends[1].reply.resolve("second done");
    expect(await second).toBe("second done");
  });

  it("does not install a late-created room after cancellation and a successor bind", async () => {
    const created = deferred<ConversationRoom>();
    const replies = deferred<string>();
    const stops: ConversationRoom[] = [];
    let current: ConversationTurnContext | undefined;
    const controller = new ConversationTurnController<string, string>({
      create: () => created.promise,
      send: (_room, _input, turn) => { current = turn; return replies.promise; },
      stop: async (room) => { stops.push(room); },
      ownershipLost: () => false,
    });
    const abort = new AbortController();
    const first = controller.request("first", { signal: abort.signal });
    const rejected = expect(first).rejects.toMatchObject({ notDispatched: true });
    abort.abort(); await rejected;
    const successorRoom = { id: "successor", roomId: "successor-room" };
    const successor = controller.request("successor", { conversation: successorRoom });
    created.resolve({ id: "stale", roomId: "stale-room" }); await tick();
    expect(controller.conversation).toEqual(successorRoom);
    expect(current?.current()).toBe(true);
    expect(stops).toEqual([]);
    replies.resolve("successor reply"); expect(await successor).toBe("successor reply");
  });

  it("cancels a stop waiter without rebinding after a successor", async () => {
    const h = harness();
    const first = h.controller.request("first", { conversation: room });
    const firstRejected = expect(first).rejects.toMatchObject({ notDispatched: false });
    await tick(); const stop = h.blockStop(); void h.controller.interrupt(); await firstRejected;
    const abort = new AbortController();
    const waiting = h.controller.request("waiting", { conversation: { id: "waiting", roomId: "waiting-room" }, signal: abort.signal });
    const waitingRejected = expect(waiting).rejects.toMatchObject({ notDispatched: true });
    abort.abort(); await waitingRejected;
    const nextRoom = { id: "next", roomId: "next-room" };
    const next = h.controller.request("next", { conversation: nextRoom });
    expect(h.controller.conversation).toEqual(nextRoom);
    expect(h.sends).toHaveLength(1);
    stop.resolve(undefined); await tick();
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1].room).toEqual(nextRoom);
    expect(h.stops).toEqual([room]);
    h.sends[1].reply.resolve("next done"); expect(await next).toBe("next done");
    expect(h.controller.conversation).toEqual(nextRoom);
  });

  it("reset settles a request waiting for Stop and fences its continuation", async () => {
    const h = harness();
    const first = h.controller.request("first", { conversation: room });
    const firstRejected = expect(first).rejects.toMatchObject({ notDispatched: false });
    await tick(); const stop = h.blockStop(); void h.controller.interrupt(); await firstRejected;
    const waiting = h.controller.request("waiting", { conversation: { id: "later", roomId: "later-room" } });
    const waitingRejected = expect(waiting).rejects.toMatchObject({ name: "AbortError", notDispatched: true });
    void h.controller.reset(); await waitingRejected;
    expect(h.controller.conversation).toBeNull();
    stop.resolve(undefined); await tick();
    expect(h.sends).toHaveLength(1);
    expect(h.controller.conversation).toBeNull();
  });

  it("marks an unconfirmed stop refusal as never dispatched", async () => {
    const h = harness();
    const first = h.controller.request("first", { conversation: room });
    const firstRejected = expect(first).rejects.toMatchObject({ notDispatched: false });
    await tick(); const stop = h.blockStop(); void h.controller.interrupt(); await firstRejected;
    const stopped = h.controller.stopped;
    const waiting = h.controller.request("waiting", { conversation: room });
    const rejected = expect(waiting).rejects.toMatchObject({ code: "stop-unconfirmed", notDispatched: true });
    stop.reject(new Error("not acknowledged")); await rejected;
    expect(h.sends).toHaveLength(1);
    expect(h.controller.stopped).toBe(stopped);
    expect(h.controller.stopped?.input).toBe("first");
  });

  it("can cancel a bind wait without cancelling the old room's Stop", async () => {
    const h = harness();
    void h.controller.send("old", h.observer); await tick();
    const stop = h.blockStop();
    const abort = new AbortController();
    const binding = h.controller.bind(room, abort.signal);
    const rejected = expect(binding).rejects.toMatchObject({ notDispatched: true });
    abort.abort(); await rejected;
    expect(h.stops).toHaveLength(1);
    stop.resolve(undefined); await tick();
    expect(h.controller.conversation).toEqual(room);
  });
});

describe("admitConversationStopReceipt", () => {
  const expected = { roomId: "expected-room", reason: "client-stop" };
  it("admits only an acknowledged signal for the expected room and request reason", () => {
    expect(admitConversationStopReceipt({ aborted: true, ...expected }, expected)).toEqual({ aborted: true, ...expected });
  });
  for (const receipt of [null, [], {}, { aborted: false, ...expected },
    { aborted: true, roomId: "other", reason: expected.reason },
    { aborted: true, roomId: expected.roomId, reason: "other" }]) {
    it(`refuses unconfirmed receipt ${JSON.stringify(receipt)}`, () => {
      expect(() => admitConversationStopReceipt(receipt, expected)).toThrow(ConversationTurnRefusal);
    });
  }
});

describe("findStoppedUserTurn", () => {
  const restored = (text: string) => text;
  it("matches by clientMessageId when the agent returns ids", () => {
    const rows = [
      { role: "user", text: "same", clientMessageId: "a", timestamp: 1 },
      { role: "assistant", text: "reply" },
      { role: "user", text: "same", clientMessageId: "b", timestamp: 2 },
    ];
    expect(
      findStoppedUserTurn(
        rows,
        { clientMessageId: "a", text: "same", sentAt: 0 },
        restored,
      ),
    ).toBe(rows[0]);
    expect(
      findStoppedUserTurn(
        rows,
        { clientMessageId: "c", text: "same", sentAt: 0 },
        restored,
      ),
    ).toBeUndefined();
  });
  it("falls back to the last matching text within the clock skew", () => {
    const sentAt = 1_000_000;
    const rows = [
      { role: "user", text: "hello", timestamp: sentAt - 500_000 },
      { role: "user", text: "hello", timestamp: sentAt - 1000 },
    ];
    expect(findStoppedUserTurn(rows, { text: "hello", sentAt }, restored)).toBe(
      rows[1],
    );
    expect(
      findStoppedUserTurn([rows[0]], { text: "hello", sentAt }, restored),
    ).toBeUndefined();
  });
});
