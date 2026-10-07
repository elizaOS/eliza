/**
 * Regression for #33927 — the client-side x402 budget must hold an amount from
 * the check until the payment is recorded. Previously `checkBudget` ran, then
 * the on-chain transfer was awaited, and only then was the payment recorded,
 * so concurrent requests to one service all passed the same daily check and
 * paid past `serviceBudgets[].dailyLimit`. This drives the public `fetch` path
 * with a mocked wallet-core whose transfer takes time, as on-chain it does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWallet } from "../wallet-core";
import { X402BudgetTracker } from "./budget";
import { X402BudgetExceededError, X402Client } from "./client";
import type { X402PaymentRequirements } from "./types";

const { agentTransferToken, checkBudget } = vi.hoisted(() => ({
  agentTransferToken: vi.fn(),
  checkBudget: vi.fn(),
}));

vi.mock("../wallet-core.js", () => ({
  agentTransferToken,
  checkBudget,
}));

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TX_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000abc";
const SERVICE = "api.example.com";
const ONE_USDC = 1_000_000n;
const CHARGED_USDC = ONE_USDC + (ONE_USDC * 77n) / 10000n;

function createWallet(): AgentWallet {
  return {
    address: "0x0000000000000000000000000000000000000001",
  } as unknown as AgentWallet;
}

function requirement(): X402PaymentRequirements {
  return {
    scheme: "exact",
    network: "base:8453",
    asset: USDC_BASE,
    amount: ONE_USDC.toString(),
    payTo: "0x0000000000000000000000000000000000000002",
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

function paymentRequiredResponse(): Response {
  return new Response(
    JSON.stringify({
      x402Version: 1,
      resource: {
        url: `https://${SERVICE}/resource`,
        description: "",
        mimeType: "application/json",
      },
      accepts: [requirement()],
    }),
    { status: 402 },
  );
}

/** 402 until the request carries a payment, then 200. */
function mockSeller() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) =>
      new Headers(init?.headers).has("X-PAYMENT")
        ? new Response("ok", { status: 200 })
        : paymentRequiredResponse(),
    );
}

function fiveDollarServiceCap() {
  return {
    serviceBudgets: [
      {
        service: SERVICE,
        maxPerRequest: CHARGED_USDC,
        dailyLimit: 5n * ONE_USDC,
      },
    ],
  };
}

describe("X402Client budget under concurrent payments (#33927)", () => {
  beforeEach(() => {
    agentTransferToken.mockReset();
    checkBudget.mockReset();
    checkBudget.mockResolvedValue({
      token: USDC_BASE,
      perTxLimit: 100n * ONE_USDC,
      remainingInPeriod: 100n * ONE_USDC,
    });
    // The transfer takes a while, like a real on-chain payment
    agentTransferToken.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(TX_HASH), 20)),
    );
  });

  it("pays at most the service daily limit when payments run concurrently", async () => {
    const fetchSpy = mockSeller();
    try {
      const client = new X402Client(createWallet(), fiveDollarServiceCap());

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          client.fetch(`https://${SERVICE}/resource?i=${i}`),
        ),
      );

      const paid = results.filter((r) => r.status === "fulfilled");
      const blocked = results.filter(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof X402BudgetExceededError,
      );
      expect(paid).toHaveLength(4);
      expect(blocked).toHaveLength(6);
      expect(client.getDailySpendSummary().byService[SERVICE]).toBe(
        4n * CHARGED_USDC,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects a principal-only service budget before any transfer", async () => {
    const fetchSpy = mockSeller();
    try {
      const client = new X402Client(createWallet(), {
        serviceBudgets: [
          { service: SERVICE, maxPerRequest: ONE_USDC, dailyLimit: ONE_USDC },
        ],
      });
      await expect(
        client.fetch(`https://${SERVICE}/resource`),
      ).rejects.toBeInstanceOf(X402BudgetExceededError);
      expect(agentTransferToken).not.toHaveBeenCalled();
      expect(client.getTransactionLog()).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each(["perTxLimit", "remainingInPeriod"] as const)(
    "rejects when the fee exceeds on-chain %s",
    async (limit) => {
      checkBudget.mockResolvedValue({
        token: USDC_BASE,
        perTxLimit: CHARGED_USDC,
        remainingInPeriod: CHARGED_USDC,
        [limit]: ONE_USDC,
      });
      const fetchSpy = mockSeller();
      try {
        const client = new X402Client(createWallet());
        await expect(
          client.fetch(`https://${SERVICE}/resource`),
        ).rejects.toThrow("including protocol fee");
        expect(agentTransferToken).not.toHaveBeenCalled();
        expect(client.getTransactionLog()).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

  it("frees the held amount when pre-transfer budget lookup fails", async () => {
    checkBudget.mockRejectedValueOnce(new Error("budget unavailable"));
    const fetchSpy = mockSeller();
    try {
      const client = new X402Client(createWallet(), {
        serviceBudgets: [
          {
            service: SERVICE,
            maxPerRequest: CHARGED_USDC,
            dailyLimit: CHARGED_USDC,
          },
        ],
      });

      await expect(client.fetch(`https://${SERVICE}/resource`)).rejects.toThrow(
        "budget unavailable",
      );

      // No transfer was attempted, so the next request may use the budget
      const response = await client.fetch(`https://${SERVICE}/resource`);
      expect(response.status).toBe(200);
      expect(client.getDailySpendSummary().byService[SERVICE]).toBe(
        CHARGED_USDC,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([1, 2])(
    "retains budget when transfer %i has an unknown outcome",
    async (failedTransfer) => {
      let calls = 0;
      agentTransferToken.mockImplementation(async () => {
        if (++calls === failedTransfer)
          throw new Error("receipt unavailable after submission");
        return TX_HASH;
      });
      const fetchSpy = mockSeller();
      try {
        const client = new X402Client(createWallet(), {
          globalDailyLimit: CHARGED_USDC,
        });
        await expect(
          client.fetch(`https://${SERVICE}/resource`),
        ).rejects.toThrow("receipt unavailable");
        await expect(
          client.fetch(`https://${SERVICE}/resource`),
        ).rejects.toBeInstanceOf(X402BudgetExceededError);
        expect(agentTransferToken).toHaveBeenCalledTimes(failedTransfer);
        expect(client.getTransactionLog()).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

  it("frees the held amount when onBeforePayment declines", async () => {
    const fetchSpy = mockSeller();
    try {
      let approve = false;
      const client = new X402Client(createWallet(), {
        serviceBudgets: [
          {
            service: SERVICE,
            maxPerRequest: CHARGED_USDC,
            dailyLimit: CHARGED_USDC,
          },
        ],
        onBeforePayment: async () => approve,
      });

      const declined = await client.fetch(`https://${SERVICE}/resource`);
      expect(declined.status).toBe(402);

      approve = true;
      const response = await client.fetch(`https://${SERVICE}/resource`);
      expect(response.status).toBe(200);
      expect(agentTransferToken).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("X402BudgetTracker reservations", () => {
  it("rejects negative holds before they can increase available budget", () => {
    const tracker = new X402BudgetTracker({ globalDailyLimit: ONE_USDC });
    expect(tracker.reserve(SERVICE, -ONE_USDC).allowed).toBe(false);
    expect(tracker.reserve(SERVICE, 2n * ONE_USDC).allowed).toBe(false);
    expect(tracker.reserve(SERVICE, ONE_USDC).allowed).toBe(true);
  });

  it("counts held amounts in the daily checks until recorded or released", () => {
    const tracker = new X402BudgetTracker(fiveDollarServiceCap());

    const holds = Array.from({ length: 10 }, () =>
      tracker.reserve(SERVICE, ONE_USDC),
    );
    expect(holds.filter((h) => h.allowed)).toHaveLength(5);
    expect(tracker.checkBudget(SERVICE, ONE_USDC).allowed).toBe(false);

    const first = holds[0];
    if (!first.allowed) throw new Error("expected the first hold to pass");
    tracker.releaseReservation(first.reservationId);
    expect(tracker.checkBudget(SERVICE, ONE_USDC).allowed).toBe(true);
  });

  it("replaces the hold with the recorded spend", () => {
    const tracker = new X402BudgetTracker(fiveDollarServiceCap());
    const hold = tracker.reserve(SERVICE, ONE_USDC);
    if (!hold.allowed) throw new Error("expected the hold to pass");

    tracker.recordPayment(
      {
        timestamp: Math.floor(Date.now() / 1000),
        service: SERVICE,
        url: `https://${SERVICE}/resource`,
        amount: ONE_USDC,
        token: USDC_BASE,
        recipient: "0x0000000000000000000000000000000000000002",
        txHash: TX_HASH,
        network: "base:8453",
        scheme: "exact",
        success: true,
      },
      hold.reservationId,
    );

    expect(tracker.getDailySpendSummary().byService[SERVICE]).toBe(ONE_USDC);
    // 1 recorded, nothing still held: 4 more fit under the $5 cap
    const more = Array.from({ length: 5 }, () =>
      tracker.reserve(SERVICE, ONE_USDC),
    );
    expect(more.filter((h) => h.allowed)).toHaveLength(4);
  });

  it("applies held amounts to the global daily limit", () => {
    const tracker = new X402BudgetTracker({ globalDailyLimit: 2n * ONE_USDC });
    expect(tracker.reserve("a.example", ONE_USDC).allowed).toBe(true);
    expect(tracker.reserve("b.example", ONE_USDC).allowed).toBe(true);
    expect(tracker.reserve("c.example", ONE_USDC).allowed).toBe(false);
  });
});
