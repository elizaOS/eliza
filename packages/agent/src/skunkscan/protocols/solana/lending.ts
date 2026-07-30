import { ChainProtocol } from "../registry";

export const SOLANA_LENDING_PROTOCOLS: Readonly<
  Record<string, ChainProtocol>
> = {
  So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo: {
    programId: "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo",
    name: "Solend",
    category: "lending",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://solend.fi",
    notes: "Solend lending and borrowing program on Solana.",
    tags: [
      "solend",
      "lending",
      "borrowing",
      "solana",
    ],
  },

  GzFgdRJXmawPhGeBsyRCDLx4jAKPsvbUqoqitzppkzkW: {
    programId: "GzFgdRJXmawPhGeBsyRCDLx4jAKPsvbUqoqitzppkzkW",
    name: "Kamino Lend",
    category: "lending",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://kamino.finance",
    notes:
      "Kamino Lend program on Solana. Program ID cross-confirmed against plugins/plugin-wallet/src/analytics/lpinfo/kamino/providers/kaminoProvider.ts, which already uses this same ID.",
    tags: [
      "kamino",
      "lending",
      "borrowing",
      "solana",
    ],
  },
};
