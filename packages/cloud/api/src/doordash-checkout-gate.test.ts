/** Verifies atomic DoorDash checkout claims and authoritative receipt replay. */

import { describe, expect, test } from "bun:test";
import { DoorDashCheckoutGate } from "./doordash-checkout-gate";

function gate(): DoorDashCheckoutGate {
  const values = new Map<string, unknown>();
  const transaction = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
  const storage = {
    transaction: async <T>(callback: (txn: typeof transaction) => Promise<T>) =>
      callback(transaction),
  };
  return new DoorDashCheckoutGate({ storage } as unknown as DurableObjectState);
}

function claim(digest: string): Request {
  return new Request("https://gate.test/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ digest }),
  });
}

function complete(digest: string, receipt: Record<string, unknown>): Request {
  return new Request("https://gate.test/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ digest, receipt }),
  });
}

describe("DoorDashCheckoutGate", () => {
  test("accepts one claim and rejects the same checkout state again", async () => {
    const instance = gate();
    const digest = "a".repeat(64);
    expect((await instance.fetch(claim(digest))).status).toBe(201);
    expect((await instance.fetch(claim(digest))).status).toBe(409);
  });

  test("rejects malformed claim input", async () => {
    const instance = gate();
    expect((await instance.fetch(claim("not-a-digest"))).status).toBe(400);
  });

  test("stores an authoritative receipt and returns it on replay", async () => {
    const instance = gate();
    const digest = "b".repeat(64);
    const receipt = {
      success: true,
      orderId: "provider-order-123",
      total: 24.5,
    };

    expect((await instance.fetch(claim(digest))).status).toBe(201);
    expect((await instance.fetch(complete(digest, receipt))).status).toBe(200);

    const replay = await instance.fetch(claim(digest));
    expect(replay.status).toBe(200);
    const replayPayload = (await replay.json()) as Record<string, unknown>;
    expect(replayPayload).toEqual({
      claimed: false,
      completed: true,
      receipt,
    });
  });

  test("rejects completing an unclaimed or unverified checkout", async () => {
    const instance = gate();
    const digest = "c".repeat(64);

    expect(
      (
        await instance.fetch(
          complete(digest, { success: true, orderId: "provider-order-1" }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await instance.fetch(
          complete(digest, { success: false, orderId: "order-1" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await instance.fetch(
          complete(digest, { success: true, orderId: "order-12345" }),
        )
      ).status,
    ).toBe(400);
  });
});
