import { WalletIntelligenceSource } from "../types";

export function getWalletIntelligenceSources(): WalletIntelligenceSource[] {
  return [
    {
      id: "helius-solana",
      name: "Helius Solana API",
      category: "blockchain_provider",
      status: "connected",
      coverage: [
        "Solana balance",
        "Solana token holdings",
        "Solana transactions",
      ],
      lastUpdatedAt: null,
      notes: ["Used as the current Solana blockchain data provider."],
    },
    {
      id: "jupiter-price-api",
      name: "Jupiter Price API",
      category: "price_provider",
      status: "connected",
      coverage: ["Solana token price estimates"],
      lastUpdatedAt: null,
      notes: ["Used for available Solana token USD pricing."],
    },
    {
      id: "skunkscan-label-registry",
      name: "SkunkScan Label Registry",
      category: "label_registry",
      status: "connected",
      coverage: ["Known wallet labels", "System and token program labels"],
      lastUpdatedAt: null,
      notes: ["Internal registry. Coverage will expand over time."],
    },
    {
      id: "skunkscan-protocol-registry",
      name: "SkunkScan Protocol Registry",
      category: "protocol_registry",
      status: "connected",
      coverage: ["Known Solana protocol program IDs"],
      lastUpdatedAt: null,
      notes: ["Internal protocol registry for DeFi and protocol detection."],
    },
    {
      id: "skunkscan-exposure-registry",
      name: "SkunkScan Exposure Registry",
      category: "exposure_registry",
      status: "connected",
      coverage: [
        "Known scam wallets",
        "Known rug-pull wallets",
        "Known suspicious wallets",
      ],
      lastUpdatedAt: null,
      notes: ["Internal exposure registry. Currently limited and expandable."],
    },
    {
      id: "external-compliance-provider",
      name: "External Compliance Provider",
      category: "compliance_provider",
      status: "planned",
      coverage: [
        "Sanctions screening",
        "Adverse media screening",
        "Commercial risk intelligence",
      ],
      lastUpdatedAt: null,
      notes: ["Planned integration for enterprise compliance coverage."],
    },
  ];
}
