import { tool } from "ai";
import { z } from "zod";
import { evmService } from "../services";

export const getEVMChains = tool({
  description:
    "List the configured EVM chains (defaults to base if none configured).",
  inputSchema: z
    .object({
      includeRpcUrls: z
        .boolean()
        .optional()
        .describe("Include default RPC URLs in the result"),
      includeExplorers: z
        .boolean()
        .optional()
        .describe("Include block explorer URLs in the result"),
    })
    .optional(),
  execute: async (input) => {
    const includeRpcUrls = input?.includeRpcUrls ?? false;
    const includeExplorers = input?.includeExplorers ?? false;

    const chains = evmService.getChains();

    const result = chains.map((chain) => ({
      id: chain.id,
      name: chain.name,
      nativeCurrency: {
        name: chain.nativeCurrency.name,
        symbol: chain.nativeCurrency.symbol,
        decimals: chain.nativeCurrency.decimals,
      },
      ...(includeRpcUrls ? { rpcUrls: chain.rpcUrls.default?.http ?? [] } : {}),
      ...(includeExplorers
        ? {
            explorers:
              chain.blockExplorers && chain.blockExplorers.default
                ? [
                    {
                      name: chain.blockExplorers.default.name,
                      url: chain.blockExplorers.default.url,
                    },
                  ]
                : [],
          }
        : {}),
    }));

    return {
      success: true,
      chainCount: result.length,
      chains: result,
    };
  },
});
