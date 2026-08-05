import { ChainProtocol } from "../registry";

// BNB Smart Chain addresses are stored lowercase, same convention as the
// Ethereum registry files - see ethereum/dex.ts for the full rationale.
export const BNB_DEX_PROTOCOLS: Readonly<Record<string, ChainProtocol>> = {
  "0x10ed43c718714eb63d5aa57b78b54704e256024e": {
    programId: "0x10ed43c718714eb63d5aa57b78b54704e256024e",
    name: "PancakeSwap: Router v2",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://pancakeswap.finance",
    notes:
      "PancakeSwap's V2 Router on BSC, the dominant BSC DEX by a wide margin. Still carries far more raw transaction volume than V3 despite V3's existence, matching how Ethereum's registry keeps Uniswap V2 Router02 alongside V3 SwapRouter02.",
    tags: [
      "pancakeswap",
      "pancakeswap-v2",
      "amm",
      "dex",
      "bnb",
    ],
  },

  "0x13f4ea83d0bd40e75c8222255bc855a974568dd4": {
    programId: "0x13f4ea83d0bd40e75c8222255bc855a974568dd4",
    name: "PancakeSwap V3: Smart Router",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://pancakeswap.finance",
    notes:
      "PancakeSwap's V3 Smart Router on BSC, combining V2/V3/StableSwap routing in one entrypoint.",
    tags: [
      "pancakeswap",
      "pancakeswap-v3",
      "amm",
      "dex",
      "bnb",
    ],
  },
};
