/**
 * Outcome reporting for the EVM swap subaction. Pins the two-part contract
 * between `SwapAction.swap` and its handler: a broadcast whose receipt cannot
 * be read comes back `confirmationStatus: "unconfirmed"`, and the handler's
 * outcome text then says so ("Confirmation is uncertain") instead of claiming
 * success — `swapSucceeded` stays false so downstream state does not record a
 * fill that has not happened.
 */
import type { Address } from "viem";
import { base } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwapAction, describeSwapOutcome } from "./actions/swap";
import type { WalletProvider } from "./providers/wallet";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const ROUTER = "0x3333333333333333333333333333333333333333" as Address;

vi.mock("@lifi/sdk", () => ({
  createConfig: vi.fn(),
  getRoutes: vi.fn(async () => ({
    routes: [
      {
        fromChainId: base.id,
        toChainId: base.id,
        fromAmount: "1000000",
        fromToken: { address: USDC },
        steps: [{}],
      },
    ],
  })),
  getStepTransaction: vi.fn(async () => ({
    transactionRequest: {
      to: ROUTER,
      value: "0",
      data: "0xdeadbeef",
      gasLimit: "300000",
      gasPrice: "1000000000",
    },
  })),
  getToken: vi.fn(),
}));

const params = {
  chain: "base" as const,
  fromToken: USDC,
  toToken: WETH,
  amount: "1",
};

function stubProvider(receipts: Array<() => Promise<unknown>>) {
  let receiptCall = 0;
  const sendTransaction = vi
    .fn()
    .mockResolvedValueOnce("0xapprovalhash")
    .mockResolvedValueOnce("0xswaphash");
  const provider = {
    chains: { base },
    getChainConfigs: () => base,
    getWalletClient: () => ({
      account: { address: ACCOUNT },
      getAddresses: async () => [ACCOUNT],
      sendTransaction,
      chain: base,
    }),
    getPublicClient: () => ({
      readContract: vi.fn().mockResolvedValue(0n),
      waitForTransactionReceipt: vi.fn(async () => {
        const next = receipts[Math.min(receiptCall, receipts.length - 1)];
        receiptCall += 1;
        return next();
      }),
    }),
  } as unknown as WalletProvider;
  return { provider, sendTransaction };
}

describe("EVM swap outcome reporting", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports an unsettled broadcast as unconfirmed and does not claim success", async () => {
    const { provider } = stubProvider([
      async () => ({ status: "success" }), // approval receipt
      async () => {
        throw new Error("Execution timed out"); // swap receipt never read
      },
    ]);
    const action = new SwapAction(provider);
    (action as unknown as Record<string, unknown>)["getSortedQuotes"] =
      async () => [
        {
          aggregator: "lifi",
          minOutputAmount: "9000000",
          swapData: {
            fromChainId: base.id,
            fromAmount: "1000000",
            fromToken: { address: USDC },
            steps: [{}],
          },
        },
      ];

    const result = await action.swap(params);

    expect(result.confirmationStatus).toBe("unconfirmed");

    const outcome = describeSwapOutcome(params, result);
    expect(outcome.succeeded).toBe(false);
    expect(outcome.text).toContain("Confirmation is uncertain");
    expect(outcome.text).toContain(result.hash);
    expect(outcome.text).not.toContain("Successfully swapped");
  });

  it("keeps the success wording for a confirmed swap", async () => {
    const { provider } = stubProvider([
      async () => ({ status: "success" }), // approval receipt
      async () => ({ status: "success" }), // swap receipt
    ]);
    const action = new SwapAction(provider);
    (action as unknown as Record<string, unknown>)["getSortedQuotes"] =
      async () => [
        {
          aggregator: "lifi",
          minOutputAmount: "9000000",
          swapData: {
            fromChainId: base.id,
            fromAmount: "1000000",
            fromToken: { address: USDC },
            steps: [{}],
          },
        },
      ];

    const result = await action.swap(params);

    expect(result.confirmationStatus).toBe("confirmed");

    const outcome = describeSwapOutcome(params, result);
    expect(outcome.succeeded).toBe(true);
    expect(outcome.text).toContain("✅ Successfully swapped");
  });
});
