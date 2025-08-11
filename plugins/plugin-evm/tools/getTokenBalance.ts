import { tool } from "ai";
import { z } from "zod";
import { erc20Abi } from "viem";
import { evmService } from "../services";

export const getTokenBalance = tool({
  description:
    "Get ERC20 token balances for the wallet across one or more chains.",
  inputSchema: z.object({
    tokenAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .describe("ERC20 token contract address"),
    chainIds: z.array(z.number()).optional().describe("Array of EVM chain ids"),
  }),
  execute: async ({ tokenAddress, chainIds }) => {
    const chains =
      chainIds && chainIds.length > 0
        ? chainIds
        : evmService.getChains().map((c) => c.id);
    const wc = evmService.getWalletClient(chains[0]);
    const [address] = await wc.getAddresses();

    const results = [] as Array<{
      chainId: number;
      balance: string;
      decimals?: number;
      symbol?: string;
    }>;

    for (const id of chains) {
      const pc = evmService.getPublicClient(id);
      const [balance, decimals, symbol] = await Promise.all([
        pc.readContract({
          address: tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }) as Promise<bigint>,
        pc.readContract({
          address: tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: "decimals",
        }) as Promise<number>,
        pc.readContract({
          address: tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: "symbol",
        }) as Promise<string>,
      ]);

      results.push({
        chainId: id,
        balance: balance.toString(),
        decimals,
        symbol,
      });
    }

    return {
      success: true,
      address,
      token: tokenAddress,
      balances: results,
    };
  },
});
