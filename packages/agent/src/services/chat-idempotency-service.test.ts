/** Verifies active reservations, expiry, replay, and scope isolation. */
import { describe, expect, it } from "vitest";
import {
  type ChatIdempotencyReservation,
  ChatIdempotencyWaitAbortedError,
  createChatIdempotencyStore,
} from "./chat-idempotency-service.ts";

describe("chat idempotency store", () => {
  it("reserves active turns and replays cloned settled outcomes", () => {
    const store = createChatIdempotencyStore<{ value: string }>({
      retentionMs: 10,
    });
    expect(store.reserve("room", "id", 1)).toBe(false);
    expect(store.reserve("room", "id", 2)).toBe(true);
    store.settle("room", "id", { value: "done" });
    const replay = store.outcome("room", "id");
    expect(replay).toEqual({ value: "done" });
    if (replay) replay.value = "mutated";
    expect(store.outcome("room", "id")).toEqual({ value: "done" });
  });

  it("isolates scopes and releases failed turns", () => {
    const store = createChatIdempotencyStore();
    expect(store.reserve("first", "id", 1)).toBe(false);
    expect(store.reserve("second", "id", 1)).toBe(false);
    store.release("first", "id");
    expect(store.reserve("first", "id", 2)).toBe(false);
  });

  it("joins an active owner and receives a cloned settled outcome", async () => {
    const store = createChatIdempotencyStore<{ value: string }>();
    const owner = store.admit("room", "id", { now: 1 });
    const duplicate = store.admit("room", "id", { now: 2 });
    expect(owner.kind).toBe("owner");
    expect(duplicate.kind).toBe("duplicate");
    if (owner.kind !== "owner" || duplicate.kind !== "duplicate") {
      throw new Error("fixture admission failed");
    }

    const joined = duplicate.wait();
    store.settle("room", "id", { value: "done" }, owner.reservation);
    const result = await joined;
    expect(result).toEqual({ kind: "settled", outcome: { value: "done" } });
    if (result.kind === "settled") result.outcome.value = "mutated";
    expect(store.outcome("room", "id")).toEqual({ value: "done" });
  });

  it("hands ownership to one retry after the original owner releases", async () => {
    const store = createChatIdempotencyStore<{ value: string }>();
    const owner = store.admit("room", "id", { now: 1 });
    const duplicate = store.admit("room", "id", { now: 2 });
    if (owner.kind !== "owner" || duplicate.kind !== "duplicate") {
      throw new Error("fixture admission failed");
    }

    const joined = duplicate.wait();
    store.release("room", "id", owner.reservation);
    await expect(joined).resolves.toEqual({ kind: "released" });

    const replacement = store.admit("room", "id", { now: 3 });
    expect(replacement.kind).toBe("owner");
  });

  it("rejects wrong, stale, and fabricated reservation ownership", async () => {
    const store = createChatIdempotencyStore<{ value: string }>();
    const owner = store.admit("room", "id", { now: 1 });
    if (owner.kind !== "owner") throw new Error("fixture admission failed");
    const wrongScope = {
      ...owner.reservation,
      scope: "other-room",
    } satisfies ChatIdempotencyReservation;
    const fabricated = {
      scope: "room",
      clientMessageId: "id",
      token: Symbol("fabricated"),
    } satisfies ChatIdempotencyReservation;

    store.release("room", "id", wrongScope);
    store.settle("room", "id", { value: "wrong" }, fabricated);
    expect(store.admit("room", "id", { now: 2 }).kind).toBe("duplicate");

    store.release("room", "id", owner.reservation);
    const replacement = store.admit("room", "id", { now: 3 });
    if (replacement.kind !== "owner") {
      throw new Error("replacement admission failed");
    }
    store.settle("room", "id", { value: "stale" }, owner.reservation);
    expect(store.admit("room", "id", { now: 4 }).kind).toBe("duplicate");
    store.settle("room", "id", { value: "current" }, replacement.reservation);
    expect(store.outcome("room", "id")).toEqual({ value: "current" });
  });

  it("removes an aborted duplicate waiter without disturbing its owner", async () => {
    const store = createChatIdempotencyStore<{ value: string }>();
    const owner = store.admit("room", "id", { now: 1 });
    const duplicate = store.admit("room", "id", { now: 2 });
    if (owner.kind !== "owner" || duplicate.kind !== "duplicate") {
      throw new Error("fixture admission failed");
    }
    const controller = new AbortController();
    const joined = duplicate.wait(controller.signal);

    controller.abort(new Error("transport closed"));
    await expect(joined).rejects.toBeInstanceOf(
      ChatIdempotencyWaitAbortedError,
    );
    store.settle("room", "id", { value: "done" }, owner.reservation);
    expect(store.outcome("room", "id")).toEqual({ value: "done" });
  });

  it("rejects active and settled key reuse with a different fingerprint", () => {
    const store = createChatIdempotencyStore<{ value: string }>();
    const owner = store.admit("principal:room", "id", {
      fingerprint: "request-a",
      now: 1,
    });
    if (owner.kind !== "owner") throw new Error("fixture admission failed");

    expect(
      store.admit("principal:room", "id", {
        fingerprint: "request-b",
        now: 2,
      }),
    ).toMatchObject({
      kind: "conflict",
      error: { code: "CHAT_IDEMPOTENCY_CONFLICT" },
    });
    store.settle("principal:room", "id", { value: "done" }, owner.reservation);
    expect(
      store.admit("principal:room", "id", {
        fingerprint: "request-b",
        now: 3,
      }),
    ).toMatchObject({
      kind: "conflict",
      error: { code: "CHAT_IDEMPOTENCY_CONFLICT" },
    });
  });

  it("isolates the same client key across authenticated principal scopes", () => {
    const store = createChatIdempotencyStore<{ value: string }>();
    expect(
      store.admit("principal-a:room", "id", { fingerprint: "request" }).kind,
    ).toBe("owner");
    expect(
      store.admit("principal-b:room", "id", { fingerprint: "request" }).kind,
    ).toBe("owner");
  });
});
