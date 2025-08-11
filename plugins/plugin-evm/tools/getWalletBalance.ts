import { tool } from "ai";
import { z } from "zod";
import { evmService } from "../services";

export const getWalletBalance = tool({
  description: "Get the native token balance for the wallet across one or more chains.",
  inputSchema: z.object({
    chainIds: z.array(z.number()).optional().describe("Array of EVM chain ids"),
  }),
  execute: async ({ chainIds }) => {
    const chains = chainIds && chainIds.length > 0 ? chainIds : evmService.getChains().map((c) => c.id);
    const wc = evmService.getWalletClient(chains[0]);
    const [address] = await wc.getAddresses();

    const results = [] as Array<{ chainId: number; balance: string }>;
    for (const id of chains) {
      const pc = evmService.getPublicClient(id);
      const balance = await pc.getBalance({ address });
      results.push({ chainId: id, balance: balance.toString() });
    }

    return {
      success: true,
      address,
      balances: results,
    };
  },
});


