import { ChainProtocol } from "../registry";

// Base addresses are stored lowercase, same convention as the Ethereum/BNB
// registry files - see ethereum/dex.ts for the full rationale.
export const BASE_DEX_PROTOCOLS: Readonly<Record<string, ChainProtocol>> = {
  "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43": {
    programId: "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43",
    name: "Aerodrome: Router",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://aerodrome.finance",
    notes:
      "Aerodrome's Router on Base, the dominant Base-native DEX (ve(3,3) model) - over 60% DEX volume share and $1.3B+ TVL on Base.",
    tags: [
      "aerodrome",
      "amm",
      "dex",
      "base",
    ],
  },

  "0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc": {
    programId: "0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc",
    name: "Uniswap: Universal Router 2",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://uniswap.org",
    notes:
      "Uniswap's Universal Router 2 on Base. Secondary to Aerodrome by volume/TVL share, but shows a higher raw transaction count on Base (6M+ vs Aerodrome Router's 4.6M+) - real, substantial retail usage, not a token-count assumption.",
    tags: [
      "uniswap",
      "universal-router",
      "amm",
      "dex",
      "base",
    ],
  },
};
