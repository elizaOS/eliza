import {
  SupportedChain,
  WalletActivitySummary,
  WalletAgeSummary,
  WalletComplianceScreeningSummary,
  WalletCustodyProfile,
  WalletDeFiSummary,
  WalletEvidenceRecord,
  WalletExposureSummary,
  WalletFundingSummary,
  WalletPortfolioSummary,
  WalletRelationshipSummary,
  WalletRiskSummary,
  WalletSmartMoneySummary,
  WalletTransactionRiskSummary,
  WalletWhaleSummary,
} from "../types";

// The chain's own data provider, cited as the evidence source for records
// backed by directly-fetched chain data (activity, age, funding, portfolio).
// Falls back to a generic, honest label for chains without a dedicated
// provider wired up yet, rather than defaulting to another chain's provider.
const EVIDENCE_SOURCE_BY_CHAIN: Partial<
  Record<SupportedChain, { sourceId: string; sourceName: string }>
> = {
  solana: { sourceId: "helius-solana", sourceName: "Helius Solana API" },
};

const UNKNOWN_CHAIN_EVIDENCE_SOURCE = {
  sourceId: "chain-data-provider",
  sourceName: "Chain Data Provider",
};

function getEvidenceSource(chain: SupportedChain): {
  sourceId: string;
  sourceName: string;
} {
  return EVIDENCE_SOURCE_BY_CHAIN[chain] ?? UNKNOWN_CHAIN_EVIDENCE_SOURCE;
}

export function analyzeWalletEvidenceRecords(
  walletAddress: string,
  activity: WalletActivitySummary,
  age: WalletAgeSummary,
  funding: WalletFundingSummary,
  portfolio: WalletPortfolioSummary,
  defi: WalletDeFiSummary,
  exposure: WalletExposureSummary,
  relationships: WalletRelationshipSummary,
  compliance: WalletComplianceScreeningSummary,
  custody: WalletCustodyProfile,
  risk: WalletRiskSummary,
  whale: WalletWhaleSummary,
  smartMoney: WalletSmartMoneySummary,
  transactionRisk: WalletTransactionRiskSummary,
  chain: SupportedChain,
): WalletEvidenceRecord[] {
  const records: WalletEvidenceRecord[] = [];

  const evidenceSource = getEvidenceSource(chain);

  records.push({
    id: "activity-summary",
    category: "activity",
    fact: `The analyzed sample contains ${activity.recentTransactionCount} recent transaction(s), with activity classified as ${activity.activityLevel}.`,
    evidenceType: "calculated_metric",
    sourceId: evidenceSource.sourceId,
    sourceName: evidenceSource.sourceName,
    confidence: "high",
    observedAt:
      typeof activity.lastActiveAt === "number"
        ? new Date(activity.lastActiveAt * 1000).toISOString()
        : null,
    relatedAddresses: [walletAddress],
    limitations: [
      "Activity classification is based on the analyzed transaction sample.",
    ],
  });

  records.push({
    id: "wallet-age",
    category: "age",
    fact: `Wallet age is classified as ${age.classification}.`,
    evidenceType: "on_chain_fact",
    sourceId: evidenceSource.sourceId,
    sourceName: evidenceSource.sourceName,
    confidence:
      age.classification === "unknown" ? "low" : "high",
    observedAt:
      typeof age.firstKnownTransactionAt === "number"
        ? new Date(age.firstKnownTransactionAt * 1000).toISOString()
        : null,
    relatedAddresses: [walletAddress],
    limitations:
      age.classification === "unknown"
        ? ["The earliest known transaction could not be determined."]
        : [],
  });

  const fundingSourceLabelName =
    funding.fundingSourceLabel &&
    funding.fundingSourceLabel.label !== "Unknown Wallet"
      ? funding.fundingSourceLabel.label
      : null;

  records.push({
    id: "funding-assessment",
    category: "funding",
    fact:
      funding.fundingWallet
        ? fundingSourceLabelName
          ? `Initial funding was attributed to ${fundingSourceLabelName} and classified as ${funding.fundingSourceType}.`
          : `Initial funding was attributed to an unlabeled wallet and classified as ${funding.fundingSourceType}.`
        : "No initial incoming funding transfer was identified in the first known transaction.",
    evidenceType:
      funding.fundingWallet
        ? "on_chain_fact"
        : "analytical_inference",
    sourceId: evidenceSource.sourceId,
    sourceName: evidenceSource.sourceName,
    confidence: funding.evidenceConfidence,
    observedAt:
      typeof funding.firstFundingAt === "number"
        ? new Date(funding.firstFundingAt * 1000).toISOString()
        : null,
    relatedAddresses: [
      walletAddress,
      ...(funding.fundingWallet ? [funding.fundingWallet] : []),
    ],
    limitations: funding.notes,
  });

  records.push({
    id: "portfolio-summary",
    category: "portfolio",
    fact: `Wallet holds ${portfolio.tokenCount} token(s) and has ${portfolio.diversityLevel} portfolio diversity.`,
    evidenceType: "calculated_metric",
    sourceId: evidenceSource.sourceId,
    sourceName: evidenceSource.sourceName,
    confidence:
      portfolio.tokenCount > 0 ? "high" : "medium",
    observedAt: null,
    relatedAddresses: [walletAddress],
    limitations: portfolio.notes,
  });

  records.push({
    id: "defi-summary",
    category: "defi",
    fact: `Detected ${defi.protocolCount} recognized DeFi protocol interaction(s); profile is ${defi.profile}.`,
    evidenceType: "registry_match",
    sourceId: "skunkscan-protocol-registry",
    sourceName: "SkunkScan Protocol Registry",
    confidence:
      defi.protocolCount > 0 ? "high" : "medium",
    observedAt: null,
    relatedAddresses: [walletAddress],
    limitations: defi.notes,
  });

  records.push({
    id: "exposure-summary",
    category: "exposure",
    fact:
      exposure.matches.length > 0
        ? `${exposure.matches.length} known exposure match(es) were identified.`
        : "No known exposure match was identified in the connected exposure registry.",
    evidenceType:
      exposure.matches.length > 0
        ? "registry_match"
        : "provider_result",
    sourceId: "skunkscan-exposure-registry",
    sourceName: "SkunkScan Exposure Registry",
    confidence: exposure.evidenceConfidence,
    observedAt: null,
    relatedAddresses: [
      walletAddress,
      ...exposure.matches.map((match) => match.address),
    ],
    limitations: exposure.notes,
  });

  records.push({
    id: "relationship-summary",
    category: "relationships",
    fact: `${relationships.relationshipCount} direct relationship(s) were identified.`,
    evidenceType:
      relationships.relationshipCount > 0
        ? "analytical_inference"
        : "provider_result",
    sourceId: "skunkscan-relationship-analysis",
    sourceName: "SkunkScan Relationship Analysis",
    confidence: relationships.evidenceConfidence,
    observedAt: null,
    relatedAddresses: [
      walletAddress,
      ...relationships.relationships.map(
        (relationship) => relationship.address,
      ),
    ],
    limitations: relationships.notes,
  });

  records.push({
    id: "compliance-screening",
    category: "compliance",
    fact: `Sanctions status: ${compliance.sanctionsStatus}. Adverse media status: ${compliance.adverseMediaStatus}.`,
    evidenceType: "provider_result",
    sourceId: "skunkscan-compliance-screening",
    sourceName: "SkunkScan Compliance Screening",
    confidence: compliance.evidenceConfidence,
    observedAt: null,
    relatedAddresses: [walletAddress],
    limitations: compliance.limitations,
  });

  records.push({
    id: "custody-profile",
    category: "custody",
    fact: `Custody profile is ${custody.custodyType}; temperature profile is ${custody.temperatureProfile}.`,
    evidenceType: "analytical_inference",
    sourceId: "skunkscan-custody-analysis",
    sourceName: "SkunkScan Custody Analysis",
    confidence: custody.confidence,
    observedAt: null,
    relatedAddresses: [walletAddress],
    limitations: custody.limitations,
  });

  records.push({
    id: "risk-assessment",
    category: "risk",
    fact: `Wallet risk level is ${risk.level}, with an internal score of ${risk.score} out of 100.`,
    evidenceType: "calculated_metric",
    sourceId: "skunkscan-risk-engine",
    sourceName: "SkunkScan Risk Engine",
    confidence: "medium",
    observedAt: null,
    relatedAddresses: [walletAddress],
    limitations: risk.reasons,
  });

  records.push({
    id: "whale-assessment",
    category: "whale",
    fact: `Whale level is ${whale.whaleLevel}, with an internal score of ${whale.whaleScore} out of 100.`,
    evidenceType: "analytical_inference",
    sourceId: "skunkscan-whale-analysis",
    sourceName: "SkunkScan Whale Analysis",
    confidence:
      whale.estimatedPortfolioUsdValue !== null &&
      whale.estimatedPortfolioUsdValue !== undefined
        ? "high"
        : "medium",
    observedAt: null,
    relatedAddresses: [walletAddress],
    limitations: whale.reasons,
  });

  records.push({
    id: "smart-money-assessment",
    category: "smart_money",
    fact: `Smart-money profile is ${smartMoney.profile}, with level ${smartMoney.level} and display score ${smartMoney.displayScore}.`,
    evidenceType: "analytical_inference",
    sourceId: "skunkscan-smart-money-analysis",
    sourceName: "SkunkScan Smart Money Analysis",
    confidence: smartMoney.confidence,
    observedAt: null,
    relatedAddresses: [walletAddress],
    limitations: smartMoney.limitations,
  });

  records.push({
    id: "transaction-risk-assessment",
    category: "transaction_risk",
    fact: `Wallet-context transaction risk is ${transactionRisk.level}, with display score ${transactionRisk.displayScore}.`,
    evidenceType: "analytical_inference",
    sourceId: "skunkscan-transaction-risk-analysis",
    sourceName: "SkunkScan Transaction Risk Analysis",
    confidence: "medium",
    observedAt: null,
    relatedAddresses: [walletAddress],
    limitations: transactionRisk.limitations,
  });

  return records;
}
