import { describe, expect, it } from "vitest";
import {
  type ConversationRoom,
  type ConversationTurnContext,
  ConversationTurnController,
  type ConversationTurnFailure,
  ConversationTurnRefusal,
  type ConversationTurnTransport,
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
