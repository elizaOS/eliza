/**
 * Exercises anonymous chat's strongly ordered cache with in-memory Durable
 * Object storage, including atomic alarms, crash recovery, terminal
 * idempotency, and revisioned counter mirroring.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { anonymousSessionsRepository } from "@/db/repositories/anonymous-sessions";
import { AnonymousChatGate } from "../src/anonymous-chat-gate";

const persistGateCounterSnapshot = spyOn(
  anonymousSessionsRepository,
  "persistGateCounterSnapshot",
);

class TestStorage {
  private readonly values = new Map<string, unknown>();
  alarm: number | undefined;
  failNextSetAlarm = false;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  read<T>(key: string): T | undefined {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  clearAlarm(): void {
    this.alarm = undefined;
  }

  async transaction<T>(
    closure: (transaction: {
      put(key: string, value: unknown): Promise<void>;
      setAlarm(scheduledTime: number): Promise<void>;
      deleteAlarm(): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const stagedValues = new Map(
      [...this.values.entries()].map(([key, value]) => [
        key,
        structuredClone(value),
      ]),
    );
    let stagedAlarm = this.alarm;
    const result = await closure({
      put: async (key, value) => {
        stagedValues.set(key, structuredClone(value));
      },
      setAlarm: async (scheduledTime) => {
        if (this.failNextSetAlarm) {
          this.failNextSetAlarm = false;
          throw new Error("injected setAlarm failure");
        }
        stagedAlarm = scheduledTime;
      },
      deleteAlarm: async () => {
        stagedAlarm = undefined;
      },
    });
    this.values.clear();
    for (const [key, value] of stagedValues) {
      this.values.set(key, value);
    }
    this.alarm = stagedAlarm;
    return result;
  }
}

function createGate(storage = new TestStorage()): AnonymousChatGate {
  return new AnonymousChatGate(
    { storage } as unknown as DurableObjectState,
    {} as never,
  );
}

function post(
  gate: AnonymousChatGate,
  path:
    | "/context"
    | "/hydrate"
    | "/lease"
    | "/dispatch"
    | "/refund"
    | "/commit",
  body: Record<string, unknown> = {},
): Promise<Response> {
  return gate.fetch(
    new Request(`https://gate.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function hydrate(
  gate: AnonymousChatGate,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<Response> {
  return await post(gate, "/hydrate", {
    sessionId: "session-a",
    userId: "user-a",
    messageCount: 0,
    messagesLimit: 10,
    hourlyMessageCount: 0,
    hourlyResetAtMs: null,
    hourlyLimit: 10,
    expiresAtMs: Date.now() + 86_400_000,
    revision: 0,
    blocked: false,
    ...overrides,
  });
}

afterEach(() => {
  spyOn(Date, "now").mockRestore();
});

beforeEach(() => {
  persistGateCounterSnapshot.mockReset();
  persistGateCounterSnapshot.mockResolvedValue(true);
});

afterAll(() => {
  persistGateCounterSnapshot.mockRestore();
});

describe("AnonymousChatGate", () => {
  test("fails cold and accepts only the first hydration snapshot", async () => {
    const gate = createGate();
    const cold = await post(gate, "/context");
    expect(cold.status).toBe(503);
    expect(await cold.json()).toHaveProperty(
      "code",
      "anonymous_chat_gate_uninitialized",
    );

    expect((await hydrate(gate, { messageCount: 2 })).status).toBe(200);
    expect((await hydrate(gate, { messageCount: 9, revision: 9 })).status).toBe(
      200,
    );

    const context = await (await post(gate, "/context")).json();
    expect(context).toHaveProperty("context.messageCount", 2);
  });

  test("serializes concurrent lifetime leases", async () => {
    const gate = createGate();
    await hydrate(gate, { messagesLimit: 1 });

    const responses = await Promise.all([
      post(gate, "/lease", { requestId: "request-a" }),
      post(gate, "/lease", { requestId: "request-b" }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 429,
    ]);
  });

  test("returns authoritative hourly retry advice through the reset boundary", async () => {
    const windowStartedAt = 1_800_000_000_000;
    let now = windowStartedAt + 60 * 60 * 1_000 - 1_001;
    spyOn(Date, "now").mockImplementation(() => now);

    const beforeBoundary = createGate();
    await hydrate(beforeBoundary, {
      hourlyMessageCount: 10,
      hourlyResetAtMs: windowStartedAt,
      expiresAtMs: windowStartedAt + 2 * 60 * 60 * 1_000,
    });
    const twoSeconds = await post(beforeBoundary, "/lease", {
      requestId: "request-before-boundary",
    });
    expect(twoSeconds.status).toBe(429);
    expect(twoSeconds.headers.get("Retry-After")).toBe("2");
    expect(await twoSeconds.json()).toMatchObject({
      admitted: false,
      reason: "hourly_limit",
      remaining: 0,
      limit: 10,
      retryAfter: 2,
    });

    now = windowStartedAt + 60 * 60 * 1_000;
    const atBoundary = createGate();
    await hydrate(atBoundary, {
      hourlyMessageCount: 10,
      hourlyResetAtMs: windowStartedAt,
      expiresAtMs: windowStartedAt + 2 * 60 * 60 * 1_000,
    });
    const oneSecond = await post(atBoundary, "/lease", {
      requestId: "request-at-boundary",
    });
    expect(oneSecond.status).toBe(429);
    expect(oneSecond.headers.get("Retry-After")).toBe("1");
    expect(await oneSecond.json()).toHaveProperty("retryAfter", 1);

    now += 1;
    const afterBoundary = createGate();
    await hydrate(afterBoundary, {
      hourlyMessageCount: 10,
      hourlyResetAtMs: windowStartedAt,
      expiresAtMs: windowStartedAt + 2 * 60 * 60 * 1_000,
    });
    const rolledOver = await post(afterBoundary, "/lease", {
      requestId: "request-after-boundary",
    });
    expect(rolledOver.status).toBe(200);
    expect(rolledOver.headers.get("Retry-After")).toBeNull();
    expect(await rolledOver.json()).toMatchObject({
      admitted: true,
      snapshot: { hourlyMessageCount: 1 },
    });
  });

  test("does not invent retry advice for the lifetime message limit", async () => {
    const gate = createGate();
    await hydrate(gate, { messageCount: 1, messagesLimit: 1 });

    const response = await post(gate, "/lease", {
      requestId: "request-lifetime-limited",
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(body).toMatchObject({
      admitted: false,
      reason: "message_limit",
      remaining: 0,
      limit: 1,
    });
    expect(body).not.toHaveProperty("retryAfter");
  });

  test("commits the quota lease and its recovery alarm atomically", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);
    await hydrate(gate);
    storage.failNextSetAlarm = true;

    await expect(
      post(gate, "/lease", { requestId: "request-atomic" }),
    ).rejects.toThrow("injected setAlarm failure");
    expect(
      storage.read<{
        messageCount: number;
        revision: number;
        activeLeases: Record<string, unknown>;
      }>("ledger"),
    ).toMatchObject({
      messageCount: 0,
      revision: 0,
      activeLeases: {},
    });
    expect(storage.alarm).toBeUndefined();

    expect(
      (await post(gate, "/lease", { requestId: "request-atomic" })).status,
    ).toBe(200);
    expect(storage.alarm).toBeNumber();
  });

  test("refunds a leased crash window and durably mirrors its revision", async () => {
    let now = 1_800_000_000_000;
    spyOn(Date, "now").mockImplementation(() => now);
    const storage = new TestStorage();
    const gate = createGate(storage);
    await hydrate(gate, { expiresAtMs: now + 86_400_000 });
    expect(
      (await post(gate, "/lease", { requestId: "request-crashed" })).status,
    ).toBe(200);
    const recoveryAt = storage.alarm;
    expect(recoveryAt).toBeNumber();

    now = recoveryAt ?? now;
    storage.clearAlarm();
    const recoveredGate = createGate(storage);
    await recoveredGate.alarm();

    expect(persistGateCounterSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        revision: 2,
        messageCount: 0,
        hourlyMessageCount: 0,
      }),
    );
    expect(storage.alarm).toBeUndefined();
    expect(await (await post(recoveredGate, "/context")).json()).toHaveProperty(
      "context.messageCount",
      0,
    );
    expect(
      await (
        await post(recoveredGate, "/refund", {
          requestId: "request-crashed",
        })
      ).json(),
    ).toMatchObject({
      refunded: true,
      duplicate: true,
      snapshot: { revision: 2, messageCount: 0 },
    });
    expect(
      (
        await post(recoveredGate, "/commit", {
          requestId: "request-crashed",
        })
      ).status,
    ).toBe(409);
  });

  test("conservatively commits a dispatched crash window", async () => {
    let now = 1_800_000_000_000;
    spyOn(Date, "now").mockImplementation(() => now);
    const storage = new TestStorage();
    const gate = createGate(storage);
    await hydrate(gate, { expiresAtMs: now + 86_400_000 });
    await post(gate, "/lease", { requestId: "request-dispatched" });
    const dispatch = await post(gate, "/dispatch", {
      requestId: "request-dispatched",
    });
    expect(await dispatch.json()).toMatchObject({
      dispatched: true,
      duplicate: false,
    });
    const recoveryAt = storage.alarm;
    expect(recoveryAt).toBeNumber();

    now = recoveryAt ?? now;
    storage.clearAlarm();
    const recoveredGate = createGate(storage);
    await recoveredGate.alarm();

    expect(persistGateCounterSnapshot).not.toHaveBeenCalled();
    expect(storage.alarm).toBeUndefined();
    expect(await (await post(recoveredGate, "/context")).json()).toHaveProperty(
      "context.messageCount",
      1,
    );
    expect(
      await (
        await post(recoveredGate, "/commit", {
          requestId: "request-dispatched",
        })
      ).json(),
    ).toMatchObject({ committed: true, duplicate: true });
    expect(
      (
        await post(recoveredGate, "/refund", {
          requestId: "request-dispatched",
        })
      ).status,
    ).toBe(409);
    expect(
      await (
        await post(recoveredGate, "/dispatch", {
          requestId: "request-dispatched",
        })
      ).json(),
    ).toMatchObject({ dispatched: true, duplicate: true });
  });

  test("retries a failed recovery snapshot from durable alarm state", async () => {
    let now = 1_800_000_000_000;
    spyOn(Date, "now").mockImplementation(() => now);
    const storage = new TestStorage();
    const gate = createGate(storage);
    await hydrate(gate, { expiresAtMs: now + 86_400_000 });
    await post(gate, "/lease", { requestId: "request-retry" });
    persistGateCounterSnapshot.mockRejectedValueOnce(
      new Error("mirror unavailable"),
    );

    now = storage.alarm ?? now;
    storage.clearAlarm();
    await expect(gate.alarm()).rejects.toThrow("mirror unavailable");
    const retryAt = storage.alarm;
    expect(retryAt).toBeNumber();

    now = retryAt ?? now;
    storage.clearAlarm();
    await gate.alarm();
    expect(persistGateCounterSnapshot).toHaveBeenCalledTimes(2);
    expect(storage.alarm).toBeUndefined();
  });

  test("makes refunds idempotent without decrementing below zero", async () => {
    const gate = createGate();
    await hydrate(gate);
    expect(
      (await post(gate, "/lease", { requestId: "request-a" })).status,
    ).toBe(200);

    const first = await post(gate, "/refund", { requestId: "request-a" });
    const second = await post(gate, "/refund", { requestId: "request-a" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      duplicate: true,
      snapshot: { messageCount: 0, hourlyMessageCount: 0, revision: 2 },
    });
  });

  test("does not subtract an old lease from a new hourly window", async () => {
    let now = 1_800_000_000_000;
    spyOn(Date, "now").mockImplementation(() => now);
    const gate = createGate();
    await hydrate(gate, {
      messagesLimit: 2,
      hourlyLimit: 1,
      expiresAtMs: now + 86_400_000,
    });

    expect(
      (await post(gate, "/lease", { requestId: "request-a" })).status,
    ).toBe(200);
    now += 60 * 60 * 1_000 + 1;
    expect(
      (await post(gate, "/refund", { requestId: "request-a" })).status,
    ).toBe(200);
    const next = await post(gate, "/lease", { requestId: "request-b" });
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({
      snapshot: { messageCount: 1, hourlyMessageCount: 1 },
    });
  });

  test("rejects commit after refund and keeps repeat commit idempotent", async () => {
    const gate = createGate();
    await hydrate(gate);
    await post(gate, "/lease", { requestId: "request-a" });
    expect(
      (await post(gate, "/commit", { requestId: "request-a" })).status,
    ).toBe(200);
    expect(
      (await post(gate, "/commit", { requestId: "request-a" })).status,
    ).toBe(200);
    expect(
      (await post(gate, "/refund", { requestId: "request-a" })).status,
    ).toBe(409);
  });
});
