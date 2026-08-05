import { ChainProtocol } from "../registry";

// See dex.ts for the lowercase-address convention used throughout
// the bnb/ registry files.
export const BNB_STAKING_PROTOCOLS: Readonly<Record<string, ChainProtocol>> = {
  "0x1adb950d8bb3da4be104211d5ab038628e477fe6": {
    programId: "0x1adb950d8bb3da4be104211d5ab038628e477fe6",
    name: "Lista DAO: Stake Manager",
    category: "staking",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://lista.org",
    notes:
      "Lista DAO's Stake Manager for slisBNB liquid staking on BSC. Clear leader by TVL (~955K BNB staked at time of research), roughly 200x the next-largest BSC liquid-staking competitor.",
    tags: [
      "lista",
      "lista-dao",
      "slisbnb",
      "liquid-staking",
      "staking",
      "bnb",
    ],
  },
};
