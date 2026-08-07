import { ChainProtocol } from "../registry";

// See dex.ts for the lowercase-address convention used throughout
// the base/ registry files.
export const BASE_NFT_PROTOCOLS: Readonly<Record<string, ChainProtocol>> = {
  "0x0000000000000068f116a894984e2db1123eb395": {
    programId: "0x0000000000000068f116a894984e2db1123eb395",
    name: "OpenSea: Seaport 1.6",
    category: "nft",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://opensea.io",
    notes:
      "OpenSea's Seaport 1.6 marketplace contract, deployed at the same deterministic address as Ethereum mainnet. Base ranks 3rd globally by NFT volume, and OpenSea leads secondary trading on Base ($389M/90-day volume, ahead of Blur's $312M at time of research).",
    tags: [
      "opensea",
      "seaport",
      "nft",
      "marketplace",
      "base",
    ],
  },
};
