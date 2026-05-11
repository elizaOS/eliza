import { beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryLocalPaymentStore,
  type LocalPaymentRequest,
  type LocalPaymentStore,
  newPaymentRequestId,
} from "./payment-store";

function record(
  overrides: Partial<LocalPaymentRequest> = {},
): LocalPaymentRequest {
  return {
    id: newPaymentRequestId(),
    provider: "x402",
    amountCents: 500,
    currency: "usd",
    paymentContext: { kind: "any_payer" },
    status: "pending",
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    metadata: {},
    ...overrides,
  };
}

describe("createInMemoryLocalPaymentStore", () => {
  let store: LocalPaymentStore;

  beforeEach(() => {
    store = createInMemoryLocalPaymentStore();
  });

  it("inserts and retrieves a payment request", async () => {
    const r = record({ reason: "test" });
    const inserted = await store.insert(r);
    expect(inserted.id).toBe(r.id);
    const fetched = await store.get(r.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.reason).toBe("test");
    // returned object should be a defensive copy
    if (fetched) fetched.amountCents = 9999;
    const refetched = await store.get(r.id);
    expect(refetched?.amountCents).toBe(500);
  });

  it("returns null for unknown ids", async () => {
    expect(await store.get("missing")).toBeNull();
  });

  it("rejects duplicate inserts", async () => {
    const r = record();
    await store.insert(r);
    await expect(store.insert(r)).rejects.toThrow(
      /payment_request_already_exists/,
    );
  });

  it("lists with status and createdSince filters", async () => {
    const a = record({ status: "pending", createdAt: 1000 });
    const b = record({ status: "settled", createdAt: 2000 });
    const c = record({ status: "pending", createdAt: 3000 });
    await store.insert(a);
    await store.insert(b);
    await store.insert(c);

    const all = await store.list();
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.createdAt)).toEqual([1000, 2000, 3000]);

    const pending = await store.list({ status: "pending" });
    expect(pending.map((r) => r.id).sort()).toEqual([a.id, c.id].sort());

    const recent = await store.list({ createdSince: 2000 });
    expect(recent.map((r) => r.id).sort()).toEqual([b.id, c.id].sort());
  });

  it("setStatus updates and merges metadata patches", async () => {
    const r = record({ metadata: { keep: 1 } });
    await store.insert(r);
    const updated = await store.setStatus(r.id, "settled", {
      settledAt: 4242,
      txRef: "tx-1",
      metadata: { extra: "v" },
    });
    expect(updated?.status).toBe("settled");
    expect(updated?.settledAt).toBe(4242);
    expect(updated?.txRef).toBe("tx-1");
    expect(updated?.metadata).toEqual({ keep: 1, extra: "v" });
  });

  it("setStatus returns null for unknown id", async () => {
    expect(await store.setStatus("missing", "settled")).toBeNull();
  });

  it("expirePast transitions only pending/delivered records past now", async () => {
    const expired = record({ status: "pending", expiresAt: 100 });
    const stillFresh = record({
      status: "pending",
      expiresAt: 10_000,
    });
    const alreadySettled = record({
      status: "settled",
      expiresAt: 50,
    });
    const delivered = record({ status: "delivered", expiresAt: 100 });
    await store.insert(expired);
    await store.insert(stillFresh);
    await store.insert(alreadySettled);
    await store.insert(delivered);

    const expiredIds = await store.expirePast(500);
    expect(expiredIds.sort()).toEqual([expired.id, delivered.id].sort());

    expect((await store.get(expired.id))?.status).toBe("expired");
    expect((await store.get(delivered.id))?.status).toBe("expired");
    expect((await store.get(stillFresh.id))?.status).toBe("pending");
    expect((await store.get(alreadySettled.id))?.status).toBe("settled");
  });
});
