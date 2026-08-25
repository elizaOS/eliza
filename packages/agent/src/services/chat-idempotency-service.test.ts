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

  // `settle` stamps `settledAt` from the real clock while `admit` accepts an
  // injected `now`. The suite's other expiry cases pass `now: 3`, which makes
  // `now - settledAt` hugely negative, so the retention branch can never fire
  // there. These cases derive `now` from the real clock so it actually does.
  it("re-admits a key reused after the retention window with new content", () => {
    const store = createChatIdempotencyStore<{ value: string }>({
      retentionMs: 10,
    });
    const owner = store.admit("principal:room", "id", {
      fingerprint: "request-a",
    });
    if (owner.kind !== "owner") throw new Error("fixture admission failed");
    store.settle("principal:room", "id", { value: "done" }, owner.reservation);

    const afterRetention = Date.now() + store.retentionMs + 1;
    const replacement = store.admit("principal:room", "id", {
      fingerprint: "request-b",
      now: afterRetention,
    });
    expect(replacement.kind).toBe("owner");
    if (replacement.kind !== "owner") throw new Error("re-admission failed");

    store.settle(
      "principal:room",
      "id",
      { value: "second" },
      replacement.reservation,
    );
    expect(store.outcome("principal:room", "id")).toEqual({ value: "second" });
  });

  it("still conflicts and still replays inside the retention window", () => {
    const store = createChatIdempotencyStore<{ value: string }>({
      retentionMs: 60_000,
    });
    const owner = store.admit("principal:room", "id", {
      fingerprint: "request-a",
    });
    if (owner.kind !== "owner") throw new Error("fixture admission failed");
    store.settle("principal:room", "id", { value: "done" }, owner.reservation);

    const inWindow = Date.now() + 1_000;
    expect(
      store.admit("principal:room", "id", {
        fingerprint: "request-b",
        now: inWindow,
      }),
    ).toMatchObject({
      kind: "conflict",
      error: { code: "CHAT_IDEMPOTENCY_CONFLICT" },
    });
    expect(
      store.admit("principal:room", "id", {
        fingerprint: "request-a",
        now: inWindow,
      }),
    ).toMatchObject({ kind: "settled", outcome: { value: "done" } });
  });

  it("does not retire an ACTIVE turn no matter how old it is", () => {
    const store = createChatIdempotencyStore<{ value: string }>({
      retentionMs: 10,
    });
    const owner = store.admit("principal:room", "id", {
      fingerprint: "request-a",
    });
    if (owner.kind !== "owner") throw new Error("fixture admission failed");

    // Never settled, so retention does not apply: a long-running generation
    // keeps its reservation and a different payload still conflicts.
    const muchLater = Date.now() + 60 * 60_000;
    expect(
      store.admit("principal:room", "id", {
        fingerprint: "request-a",
        now: muchLater,
      }).kind,
    ).toBe("duplicate");
    expect(
      store.admit("principal:room", "id", {
        fingerprint: "request-b",
        now: muchLater,
      }),
    ).toMatchObject({
      kind: "conflict",
      error: { code: "CHAT_IDEMPOTENCY_CONFLICT" },
    });
  });

  it("normalizes keys with default and custom length limits, rejecting invalid values", () => {
    const store = createChatIdempotencyStore();
    expect(store.normalize("  client-key-1  ")).toBe("client-key-1");
    expect(store.normalize("")).toBeNull();
    expect(store.normalize("   ")).toBeNull();
    expect(store.normalize(123)).toBeNull();
    expect(store.normalize(null)).toBeNull();
    expect(store.normalize(undefined)).toBeNull();
    expect(store.normalize({})).toBeNull();
    expect(store.normalize("a".repeat(128))).toBe("a".repeat(128));
    expect(store.normalize("a".repeat(129))).toBeNull();

    const boundedStore = createChatIdempotencyStore({ maxKeyLength: 10 });
    expect(boundedStore.normalize("a".repeat(10))).toBe("a".repeat(10));
    expect(boundedStore.normalize("a".repeat(11))).toBeNull();
  });

  it("tracks and returns firstSeenAt for active and settled keys and null for missing or unkeyed", () => {
    const store = createChatIdempotencyStore();
    expect(store.firstSeenAt("room", null)).toBeNull();
    expect(store.firstSeenAt("room", "unknown")).toBeNull();

    store.admit("room", "admitted", { now: 12345 });
    expect(store.firstSeenAt("room", "admitted")).toBe(12345);

    store.reserve("room", "reserved", 54321);
    expect(store.firstSeenAt("room", "reserved")).toBe(54321);
  });

  it("resets the store and notifies active duplicate waiters as released", async () => {
    const store = createChatIdempotencyStore<{ value: string }>();
    const owner = store.admit("room", "id", { now: 1 });
    const duplicate = store.admit("room", "id", { now: 2 });
    if (owner.kind !== "owner" || duplicate.kind !== "duplicate") {
      throw new Error("fixture admission failed");
    }

    const waiter = duplicate.wait();
    store.reset();

    await expect(waiter).resolves.toEqual({ kind: "released" });
    expect(store.firstSeenAt("room", "id")).toBeNull();
    expect(store.outcome("room", "id")).toBeNull();
  });

  it("safely handles unkeyed requests across all store methods", () => {
    const store = createChatIdempotencyStore<{ value: string }>();
    expect(store.admit("room", null)).toEqual({ kind: "unkeyed" });
    expect(store.reserve("room", null)).toBe(false);
    expect(store.outcome("room", null)).toBeNull();
    expect(() => store.release("room", null)).not.toThrow();
    expect(() => store.settle("room", null, { value: "done" })).not.toThrow();
  });
});
