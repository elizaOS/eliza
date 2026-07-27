import { SolanaProtocol } from "../registry";

export const SOLANA_LAUNCHPAD_PROTOCOLS: Readonly<
  Record<string, SolanaProtocol>
> = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": {
    programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    name: "pump.fun",
    category: "launchpad",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://pump.fun",
    notes:
      "pump.fun is a Solana memecoin launchpad and bonding-curve trading program.",
    tags: [
      "pump.fun",
      "launchpad",
      "memecoin",
      "bonding-curve",
      "solana",
    ],
  },
};
