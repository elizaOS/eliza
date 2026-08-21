/** Verifies the per-user DoorDash checkout gate atomically rejects duplicate claims. */

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
});
