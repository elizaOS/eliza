/**
 * Pending-video settlement persistence contract: a credit reservation is
 * created only when the caller did not already hold one, deferred admission
 * is released exactly once (only for a newly created reservation), and the
 * durable generation row carries the full billing provenance.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const reserveCalls: unknown[] = [];
const createCalls: unknown[] = [];
const reserveResult = {
  reservationTransactionId: "rtx-new-1",
  reservedAmount: 4.25,
};
let reserveShouldReject = false;

mock.module("../credits", () => ({
  creditsService: {
    reserve: (input: unknown) => {
      reserveCalls.push(input);
      if (reserveShouldReject) return Promise.reject(new Error("insufficient credits"));
      return Promise.resolve(reserveResult);
    },
  },
}));

mock.module("../generations", () => ({
  generationsService: {
    create: (input: unknown) => {
      createCalls.push(input);
      return Promise.resolve({ id: (input as { id: string }).id });
    },
  },
}));

const { persistPendingVideoSettlement } = await import("../pending-video-settlement");

function baseInput() {
  return {
    generationId: "gen-123",
    requestId: "req-456",
    organizationId: "org-1",
    userId: "user-1",
    model: "video-1",
    prompt: "a scenic flyover",
    provider: "runway",
    billingSource: "credits",
    totalCost: 4.25,
    durationSeconds: 12,
    parameters: { resolution: "720p" },
    settlementMarker: "marker-xyz",
  };
}

describe("persistPendingVideoSettlement", () => {
  beforeEach(() => {
    reserveCalls.length = 0;
    createCalls.length = 0;
    reserveShouldReject = false;
  });

  test("reserves credits and releases deferred admission when no reservation is held", async () => {
    let released = 0;
    await persistPendingVideoSettlement({
      ...baseInput(),
      releaseDeferredAdmission: async () => {
        released += 1;
      },
    });

    expect(reserveCalls).toHaveLength(1);
    expect(reserveCalls[0]).toEqual({
      organizationId: "org-1",
      userId: "user-1",
      amount: 4.25,
      description: "Pending video generation: video-1",
    });
    expect(released).toBe(1);
    expect(createCalls).toHaveLength(1);
  });

  test("writes the durable generation row with full billing provenance", async () => {
    await persistPendingVideoSettlement({
      ...baseInput(),
      releaseDeferredAdmission: async () => {},
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({
      id: "gen-123",
      organization_id: "org-1",
      user_id: "user-1",
      type: "video",
      model: "video-1",
      provider: "runway",
      prompt: "a scenic flyover",
      status: "pending",
      parameters: { resolution: "720p" },
      metadata: {
        settlement_marker: "marker-xyz",
        reservation_transaction_id: "rtx-new-1",
        reserved_amount: 4.25,
        billed_cost: 4.25,
        billing_source: "credits",
      },
      dimensions: { duration: 12 },
      cost: "4.25",
      credits: "4.25",
      job_id: "req-456",
    });
  });

  test("reuses an existing reservation and skips the admission release", async () => {
    let released = 0;
    const existing = {
      reservationTransactionId: "rtx-existing-9",
      reservedAmount: 9.99,
    };
    await persistPendingVideoSettlement({
      ...baseInput(),
      existingReservation: existing,
      releaseDeferredAdmission: async () => {
        released += 1;
      },
    });

    expect(reserveCalls).toHaveLength(0);
    expect(released).toBe(0);
    const row = createCalls[0] as {
      metadata: {
        reservation_transaction_id: string;
        reserved_amount: number;
      };
    };
    expect(row.metadata.reservation_transaction_id).toBe("rtx-existing-9");
    expect(row.metadata.reserved_amount).toBe(9.99);
  });

  test("propagates reservation failures instead of writing a pending row", async () => {
    reserveShouldReject = true;
    await expect(
      persistPendingVideoSettlement({
        ...baseInput(),
        releaseDeferredAdmission: async () => {},
      }),
    ).rejects.toThrow("insufficient credits");

    expect(createCalls).toHaveLength(0);
  });
});
