import { ChainProtocol } from "../registry";

export const SOLANA_STAKING_PROTOCOLS: Readonly<
  Record<string, ChainProtocol>
> = {
  MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD: {
    programId: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",
    name: "Marinade Finance",
    category: "staking",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://marinade.finance",
    notes:
      "Marinade liquid staking program on Solana. This corrects an incorrect program ID (MarBmsSgKXdrN1egZf5sqe1TMjuQd6QnP7P6o9uY8Hh) previously found in the now-deleted registry/protocolRegistry.ts.",
    tags: [
      "marinade",
      "liquid-staking",
      "staking",
      "msol",
      "solana",
    ],
  },

  SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy: {
    programId: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    name: "SPL Stake Pool",
    category: "staking",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    notes:
      "Generic SPL Stake Pool program shared by multiple stake pool operators (including but not limited to Jito). A match on this program ID identifies interaction with some stake pool built on this shared program — it does not identify which specific pool was used, and must not be presented to users as \"this wallet used Jito\" specifically.",
    tags: [
      "spl-stake-pool",
      "staking",
      "liquid-staking",
      "shared-program",
      "solana",
    ],
  },
};
