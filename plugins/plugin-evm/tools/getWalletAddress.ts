import { tool } from "ai";
import { z } from "zod";
import { evmService } from "../services";

export const getWalletAddress = tool({
  description: "Get the wallet address derived from WALLET_PRIVATE_KEY for the default chain.",
  inputSchema: z.object({
    chainId: z.number().optional().describe("Optional EVM chain id to use"),
  }),
  execute: async ({ chainId }) => {
    const wc = evmService.getWalletClient(chainId);
    const [address] = await wc.getAddresses();
    return {
      success: true,
      chainId: wc.chain?.id,
      address,
    };
  },
});


