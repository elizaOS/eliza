/**
 * The payment callbacks share one `paymentId` per attempt, and
 * `onPaymentFailed` reports an approved payment that did not complete. That is
 * what an external budget (per agent, per room, per task) needs to hold an
 * amount in `onBeforePayment` and settle or release exactly that hold later,
 * even when payments run concurrently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWallet } from "../wallet-core";
import { X402Client } from "./client";
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

function mockSeller() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
    new Headers(init?.headers).has("X-PAYMENT")
      ? new Response("ok", { status: 200 })
      : new Response(
          JSON.stringify({
            x402Version: 1,
            resource: {
              url: `https://${SERVICE}/r`,
              description: "",
              mimeType: "application/json",
            },
            accepts: [requirement()],
          }),
          { status: 402 },
        ),
  );
}

/** A minimal external budget keyed by paymentId, as an agent runtime might keep. */
function externalBudget(limit: bigint) {
  const held = new Map<string, bigint>();
  let spent = 0n;
  const heldTotal = () => [...held.values()].reduce((a, b) => a + b, 0n);
  return {
    held,
    spent: () => spent,
    config: {
      onBeforePayment: (
        req: X402PaymentRequirements,
        _url: string,
        { paymentId }: { paymentId: string },
      ) => {
        const amount = BigInt(req.amount);
        if (spent + heldTotal() + amount > limit) return false;
        held.set(paymentId, amount);
        return true;
      },
      onPaymentComplete: (
        _log: unknown,
        { paymentId }: { paymentId: string },
      ) => {
        spent += held.get(paymentId) ?? 0n;
        held.delete(paymentId);
      },
      onPaymentFailed: (
        _req: unknown,
        _url: string,
        _err: unknown,
        a: { paymentId: string; transferAttempted: boolean },
      ) => {
        if (!a.transferAttempted) held.delete(a.paymentId);
      },
    },
  };
}

describe("X402Client payment attempt callbacks", () => {
  beforeEach(() => {
    agentTransferToken.mockReset();
    checkBudget.mockReset();
    checkBudget.mockResolvedValue({
      token: USDC_BASE,
      perTxLimit: 100n * ONE_USDC,
      remainingInPeriod: 100n * ONE_USDC,
    });
    agentTransferToken.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(TX_HASH), 20)),
    );
  });

  it("passes the same paymentId to onBeforePayment and onPaymentComplete", async () => {
    const fetchSpy = mockSeller();
    try {
      const ids: string[] = [];
      const client = new X402Client(createWallet(), {
        onBeforePayment: (_req, _url, { paymentId }) => {
          ids.push(paymentId);
          return true;
        },
        onPaymentComplete: (_log, { paymentId }) => ids.push(paymentId),
      });

      await client.fetch(`https://${SERVICE}/r`);

      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe(ids[1]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reports an approved payment that failed before any transfer", async () => {
    checkBudget.mockRejectedValueOnce(new Error("rpc down"));
    const fetchSpy = mockSeller();
    try {
      const before: string[] = [];
      const onPaymentFailed = vi.fn();
      const client = new X402Client(createWallet(), {
        onBeforePayment: (_req, _url, { paymentId }) => {
          before.push(paymentId);
          return true;
        },
        onPaymentFailed,
      });

      await expect(client.fetch(`https://${SERVICE}/r`)).rejects.toThrow(
        "rpc down",
      );

      expect(onPaymentFailed).toHaveBeenCalledOnce();
      const [, , error, attempt] = onPaymentFailed.mock.calls[0];
      expect((error as Error).message).toBe("rpc down");
      expect(attempt).toEqual({
        paymentId: before[0],
        transferAttempted: false,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([1, 2])(
    "keeps payment correlation when transfer %i has an unknown outcome",
    async (failedTransfer) => {
      let calls = 0;
      agentTransferToken.mockImplementation(async () => {
        if (++calls === failedTransfer) throw new Error("receipt timeout");
        return TX_HASH;
      });
      const fetchSpy = mockSeller();
      try {
        const onPaymentFailed = vi.fn();
        let approvedPaymentId: string | undefined;
        const client = new X402Client(createWallet(), {
          onBeforePayment: (_req, _url, { paymentId }) => {
            approvedPaymentId = paymentId;
            return true;
          },
          onPaymentFailed,
        });

        await expect(client.fetch(`https://${SERVICE}/r`)).rejects.toThrow(
          "receipt timeout",
        );

        expect(onPaymentFailed).toHaveBeenCalledOnce();
        expect(onPaymentFailed.mock.calls[0][3]).toEqual({
          paymentId: approvedPaymentId,
          transferAttempted: true,
        });
        expect(agentTransferToken).toHaveBeenCalledTimes(failedTransfer);
        expect(client.getTransactionLog()).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

  it("does not report a payment that onBeforePayment declined", async () => {
    const fetchSpy = mockSeller();
    try {
      const onPaymentFailed = vi.fn();
      const client = new X402Client(createWallet(), {
        onBeforePayment: () => false,
        onPaymentFailed,
      });

      const response = await client.fetch(`https://${SERVICE}/r`);

      expect(response.status).toBe(402);
      expect(onPaymentFailed).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("lets an external budget hold and settle each concurrent payment exactly", async () => {
    // The first transfer fails before anything is sent; the rest succeed
    checkBudget.mockRejectedValueOnce(new Error("rpc down"));
    const fetchSpy = mockSeller();
    try {
      const budget = externalBudget(3n * ONE_USDC);
      const client = new X402Client(createWallet(), budget.config);

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          client.fetch(`https://${SERVICE}/r?i=${i}`),
        ),
      );
      const paid = results.filter(
        (r) => r.status === "fulfilled" && r.value.status === 200,
      ).length;

      // Every hold was settled or released, spend matches what completed,
      // and the failed payment never counted
      expect(budget.held.size).toBe(0);
      expect(budget.spent()).toBe(BigInt(paid) * ONE_USDC);
      expect(budget.spent() <= 3n * ONE_USDC).toBe(true);
      expect(results.some((r) => r.status === "rejected")).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
