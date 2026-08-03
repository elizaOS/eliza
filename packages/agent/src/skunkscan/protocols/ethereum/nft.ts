import { ChainProtocol } from "../registry";

// See dex.ts for the lowercase-address convention used throughout
// the ethereum/ registry files.
export const ETHEREUM_NFT_PROTOCOLS: Readonly<
  Record<string, ChainProtocol>
> = {
  "0x0000000000000068f116a894984e2db1123eb395": {
    programId: "0x0000000000000068f116a894984e2db1123eb395",
    name: "OpenSea Seaport 1.6",
    category: "nft",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://opensea.io",
    notes: "OpenSea's current Seaport 1.6 marketplace contract on Ethereum mainnet.",
    tags: [
      "opensea",
      "seaport",
      "nft",
      "marketplace",
      "ethereum",
    ],
  },

  "0x000000000000ad05ccc4f10045630fb830b95127": {
    programId: "0x000000000000ad05ccc4f10045630fb830b95127",
    name: "Blur.io Marketplace",
    category: "nft",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://blur.io",
    notes: "Blur's original marketplace contract on Ethereum mainnet.",
    tags: [
      "blur",
      "nft",
      "marketplace",
      "ethereum",
    ],
  },

  "0x39da41747a83aee658334415666f3ef92dd0d541": {
    programId: "0x39da41747a83aee658334415666f3ef92dd0d541",
    name: "Blur.io Marketplace 2",
    category: "nft",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://blur.io",
    notes: "Blur's second marketplace contract deployment, alongside the original above.",
    tags: [
      "blur",
      "nft",
      "marketplace",
      "ethereum",
    ],
  },
};
