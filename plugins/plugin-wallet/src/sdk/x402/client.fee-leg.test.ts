/**
 * Regression for #22381 — the x402 protocol-fee leg must resolve symbol-form
 * assets to their on-chain address, exactly like the payment leg. A 402 that
 * names its asset by symbol ("USDC") previously forwarded the raw string to
 * `agentTransferToken`, which ABI-encodes it as an `address` and throws
 * `InvalidAddressError`. This drives both the private `executePayment` path and
 * the public `fetch` entry point through a mocked wallet-core, asserting BOTH
 * transfer legs receive the resolved address and that the recorded transaction
 * is logged against the resolved address, never the symbol.
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

// USDC on Base (chainId 8453) — the address the symbol must resolve to.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TX_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000abc";

function createWallet(): AgentWallet {
  return {
    address: "0x0000000000000000000000000000000000000001",
  } as unknown as AgentWallet;
}

function symbolRequirement(): X402PaymentRequirements {
  return {
    scheme: "exact",
    network: "base:8453",
    // Symbol form, NOT an address — this is the case #22381 regressed on.
    asset: "USDC",
    // Large enough that the 0.77% fee floors to a non-zero base-unit amount.
    amount: "1000000",
    payTo: "0x0000000000000000000000000000000000000002",
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

describe("X402Client fee leg asset resolution (#22381)", () => {
  beforeEach(() => {
    agentTransferToken.mockReset();
    checkBudget.mockReset();
    checkBudget.mockResolvedValue({
      token: USDC_BASE,
      perTxLimit: 10_000_000n,
      remainingInPeriod: 10_000_000n,
    });
    agentTransferToken.mockResolvedValue(TX_HASH);
  });

  it("resolves the symbol on BOTH the fee leg and the payment leg", async () => {
    const client = new X402Client(createWallet());
    const executePayment = (
      client as unknown as {
        executePayment: (
          req: X402PaymentRequirements,
        ) => Promise<{ txHash: string; token: string }>;
      }
    ).executePayment.bind(client);

    const result = await executePayment(symbolRequirement());

    // Fee leg + payment leg = two transfers, both with a resolved address.
    expect(agentTransferToken).toHaveBeenCalledTimes(2);
    for (const call of agentTransferToken.mock.calls) {
      const params = call[1] as { token: string; amount: bigint };
      expect(params.token).toBe(USDC_BASE);
      expect(params.token).not.toBe("USDC");
    }

    // Fee is 0.77% (77 bps) of the amount; payment leg sends the full amount.
    const feeCall = agentTransferToken.mock.calls[0][1] as { amount: bigint };
    const payCall = agentTransferToken.mock.calls[1][1] as { amount: bigint };
    expect(feeCall.amount).toBe((1_000_000n * 77n) / 10_000n);
    expect(payCall.amount).toBe(1_000_000n);

    // The returned token is the resolved address, so the transaction log is
    // recorded against what was actually transferred, not the raw symbol.
    expect(result.token).toBe(USDC_BASE);
    expect(result.txHash).toBe(TX_HASH);
  });

  it("records the resolved address in the transaction log via the public fetch path", async () => {
    // Drive the real contract boundary — `fetch` consuming a 402 — so the
    // second half of the fix (the caller using the returned token) is pinned.
    // A regression that logs `selected.asset` instead of the resolved token
    // would surface here as a symbol in the recorded transaction.
    const paymentRequired = {
      x402Version: 1,
      resource: {
        url: "https://api.example.com/resource",
        description: "",
        mimeType: "application/json",
      },
      accepts: [symbolRequirement()],
    };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(paymentRequired), { status: 402 }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    try {
      const client = new X402Client(createWallet());
      const response = await client.fetch("https://api.example.com/resource");

      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const log = client.getTransactionLog();
      expect(log).toHaveLength(1);
      expect(log[0].token).toBe(USDC_BASE);
      expect(log[0].token).not.toBe("USDC");
      expect(log[0].txHash).toBe(TX_HASH);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
