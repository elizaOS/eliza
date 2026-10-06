import { describe, expect, it } from "vitest";
import type { TransferContext } from "./transfers.js";
import { getTokenBalance } from "./transfers.js";

describe("getTokenBalance", () => {
  it("returns a readable balance when optional ERC-20 metadata methods are absent", async () => {
    const tokenAddress = "0x1111111111111111111111111111111111111111" as const;
    const account = "0x2222222222222222222222222222222222222222" as const;
    const publicClient = {
      readContract: ({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case "balanceOf":
            return Promise.resolve(1_234_000n);
          case "decimals":
            return Promise.resolve(6);
          case "symbol":
          case "name":
            return Promise.reject(new Error("optional metadata is absent"));
          default:
            throw new Error(`Unexpected contract read: ${functionName}`);
        }
      },
    } as unknown as TransferContext["publicClient"];

    const result = await getTokenBalance(
      {
        publicClient,
        walletClient: {} as TransferContext["walletClient"],
        account,
      },
      tokenAddress,
    );

    expect(result).toMatchObject({
      address: tokenAddress,
      symbol: "UNKNOWN",
      name: "Unknown token",
      decimals: 6,
      rawBalance: 1_234_000n,
      humanBalance: "1.234",
      formatted: "1.23 UNKNOWN",
    });
  });
});
