import { InvestigationCase } from "../types";
import { InvestorWalletChange } from "../timelineTypes";

export function compareRisk(
  previous: InvestigationCase,
  current: InvestigationCase,
): InvestorWalletChange[] {

  const previousRisk =
    previous.walletAnalysis?.risk?.score;

  const currentRisk =
    current.walletAnalysis?.risk?.score;

  if (
    typeof previousRisk !== "number" ||
    typeof currentRisk !== "number"
  ) {
    return [];
  }

  if (previousRisk === currentRisk) {
    return [];
  }

  const difference = Number(
    (currentRisk - previousRisk).toFixed(2),
  );

  const direction =
    difference > 0 ? "increased" : "decreased";

  return [
    {
      id: `risk_${Date.now()}`,

      category: "risk",

      title: "Risk score changed",

      description:
        `Risk score ${direction} from ${previousRisk.toFixed(
          1,
        )} to ${currentRisk.toFixed(1)}.`,

      direction,

      impact:
        difference > 0
          ? "negative"
          : "positive",

      severity:
        Math.abs(difference) >= 3
          ? "high"
          : Math.abs(difference) >= 1
          ? "medium"
          : "low",

      previousValue: previousRisk,

      currentValue: currentRisk,

      absoluteChange: difference,

      percentageChange: previousRisk
        ? Number(
            (
              (difference / previousRisk) *
              100
            ).toFixed(2),
          )
        : null,

      investorMeaning:
        difference > 0
          ? "The overall risk indicators observed for this wallet are higher than in the previous investigation."
          : "The overall risk indicators observed for this wallet are lower than in the previous investigation.",

      detectedAt: new Date().toISOString(),
    },
  ];
}
