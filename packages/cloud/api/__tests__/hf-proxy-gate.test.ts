/**
 * Exercises HuggingFace proxy egress admission against in-memory Durable
 * Object storage, including atomic reservation adjustment, month rollover,
 * terminal idempotency, and storage failures.
 */

import { describe, expect, test } from "bun:test";
import { HfProxyGate } from "../src/hf-proxy-gate";

interface StoredLedger {
  monthBucket: string;
  usedBytes: number;
  activeDownloads: number;
}

class TestStorage {
  private readonly values = new Map<string, unknown>();
  failNextPut = false;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put(key: string, value: unknown): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("injected storage failure");
    }
    this.values.set(key, structuredClone(value));
  }

  read<T>(key: string): T | undefined {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
}

function createGate(storage = new TestStorage()): HfProxyGate {
  return new HfProxyGate(
    { storage } as unknown as DurableObjectState,
    {} as never,
  );
}

function post(
  gate: HfProxyGate,
  path: "/reserve" | "/settle" | "/cancel",
  body: Record<string, unknown>,
): Promise<Response> {
  return gate.fetch(
    new Request(`https://gate.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function reserve(
  gate: HfProxyGate,
  requestId: string,
  estimatedBytes: number,
  monthBucket = "2026-08",
): Promise<Response> {
  return post(gate, "/reserve", {
    requestId,
    estimatedBytes,
    limitBytes: 10,
    maxConcurrent: 4,
    monthBucket,
  });
}

describe("HfProxyGate", () => {
  test("atomically adjusts active reservations against the shared budget", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);

    expect((await reserve(gate, "request-a", 0)).status).toBe(200);
    expect((await reserve(gate, "request-b", 0)).status).toBe(200);
    expect((await reserve(gate, "request-a", 8)).status).toBe(200);

    const rejected = await reserve(gate, "request-b", 8);
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({
      admitted: false,
      usedBytes: 8,
      activeDownloads: 2,
    });

    expect(storage.read<StoredLedger>("ledger")).toMatchObject({
      monthBucket: "2026-08",
      usedBytes: 8,
      activeDownloads: 2,
    });
  });

  test("settlement and cancellation retries are idempotent", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);

    expect((await reserve(gate, "settled", 6)).status).toBe(200);
    const settlement = {
      requestId: "settled",
      actualBytes: 4,
      monthBucket: "2026-08",
    };
    expect((await post(gate, "/settle", settlement)).status).toBe(200);
    expect((await post(gate, "/settle", settlement)).status).toBe(200);

    expect((await reserve(gate, "cancelled", 3)).status).toBe(200);
    const cancellation = {
      requestId: "cancelled",
      monthBucket: "2026-08",
    };
    expect((await post(gate, "/cancel", cancellation)).status).toBe(200);
    expect((await post(gate, "/cancel", cancellation)).status).toBe(200);

    expect(storage.read<StoredLedger>("ledger")).toMatchObject({
      usedBytes: 4,
      activeDownloads: 0,
    });
  });

  test("late prior-month operations cannot replace a newer ledger", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);

    expect((await reserve(gate, "august", 7)).status).toBe(200);
    expect((await reserve(gate, "september", 3, "2026-09")).status).toBe(200);

    expect(
      (
        await post(gate, "/settle", {
          requestId: "august",
          actualBytes: 7,
          monthBucket: "2026-08",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/cancel", {
          requestId: "august",
          monthBucket: "2026-08",
        })
      ).status,
    ).toBe(200);

    expect(storage.read<StoredLedger>("ledger")).toMatchObject({
      monthBucket: "2026-09",
      usedBytes: 3,
      activeDownloads: 1,
    });
  });

  test("storage failures fail closed without mutating cached accounting", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);
    storage.failNextPut = true;

    expect((await reserve(gate, "request-a", 4)).status).toBe(503);
    expect(storage.read("ledger")).toBeUndefined();

    expect((await reserve(gate, "request-a", 4)).status).toBe(200);
    expect(storage.read<StoredLedger>("ledger")).toMatchObject({
      usedBytes: 4,
      activeDownloads: 1,
    });
  });

  test("corrupt persisted accounting fails closed", async () => {
    const storage = new TestStorage();
    await storage.put("ledger", {
      monthBucket: "2026-08",
      usedBytes: -1,
      activeDownloads: 0,
      slots: {},
      terminalRequestIds: [],
    });
    const gate = createGate(storage);

    expect((await reserve(gate, "request-a", 1)).status).toBe(503);
  });
});
