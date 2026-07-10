import {
  WalletEvidenceItem,
  WalletEvidenceRecord,
} from "../types";

export function analyzeWalletEvidence(
  evidenceRecords: WalletEvidenceRecord[],
): WalletEvidenceItem[] {
  return evidenceRecords.map((record) => ({
    id: record.id,

    category:
      record.category === "relationships"
        ? "funding"
        : record.category === "compliance"
          ? "risk"
          : record.category === "custody"
            ? "behavior"
            : record.category === "smart_money"
              ? "behavior"
              : record.category === "transaction_risk"
                ? "risk"
                : record.category,

    severity:
      record.confidence === "high"
        ? "info"
        : record.confidence === "medium"
          ? "low"
          : "medium",

    title: record.fact,

    description:
      record.limitations.length > 0
        ? record.limitations[0]
        : `Source: ${record.sourceName}`,
  }));
}
