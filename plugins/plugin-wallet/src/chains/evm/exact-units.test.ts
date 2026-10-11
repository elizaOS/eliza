import { ElizaError } from "@elizaos/core";
import type { Address } from "viem";
import { base } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import { SwapAction } from "./actions/swap";
import { TransferAction } from "./actions/transfer";
import { parseEvmBaseUnits } from "./exact-units";
import type { WalletProvider } from "./providers/wallet";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;

function stubWalletProvider() {
  const sendTransaction = vi.fn(async () => "0xhash");
  const provider = {
    chains: { base },
    getChainConfigs: () => base,
    getWalletClient: () => ({
      account: { address: ACCOUNT },
      getAddresses: async () => [ACCOUNT],
      sendTransaction,
    }),
    getPublicClient: () => ({ readContract: async () => 6 }),
  } as unknown as WalletProvider;
  return { provider, sendTransaction };
}

const notRepresentable = (value: unknown) =>
  value instanceof ElizaError && value.code === "EVM_AMOUNT_NOT_REPRESENTABLE";

describe("EVM amounts the token cannot hold", () => {
  it("refuses precision past the token decimals and keeps exact amounts", () => {
    expect(() => parseEvmBaseUnits("1.0000005", 6)).toThrow(ElizaError);
    expect(() => parseEvmBaseUnits("0.0000001", 6)).toThrow(ElizaError);
    expect(() => parseEvmBaseUnits("1.5", 0)).toThrow(ElizaError);
    expect(parseEvmBaseUnits("1.5", 6)).toBe(1_500_000n);
    expect(parseEvmBaseUnits("1.5000000", 6)).toBe(1_500_000n);
    expect(parseEvmBaseUnits("0.000001", 6)).toBe(1n);
  });

  it("does not sign a native transfer of a fraction of a wei", async () => {
    const { provider, sendTransaction } = stubWalletProvider();
    const action = new TransferAction(provider);

    await expect(
      action.transfer({
        fromChain: "base",
        toAddress: RECIPIENT,
        amount: "0.0000000000000000015",
      }),
    ).rejects.toSatisfy(notRepresentable);
    expect(sendTransaction).not.toHaveBeenCalled();

    const tx = await action.transfer({
      fromChain: "base",
      toAddress: RECIPIENT,
      amount: "0.5",
    });
    expect(tx.value).toBe(500_000_000_000_000_000n);
  });

  it("refuses a swap amount before any aggregator is asked for a quote", async () => {
    const { provider, sendTransaction } = stubWalletProvider();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      new SwapAction(provider).swap({
        chain: "base",
        fromToken: USDC,
        toToken: WETH,
        amount: "1.0000005",
      }),
    ).rejects.toSatisfy(notRepresentable);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
