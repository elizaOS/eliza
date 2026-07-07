import {
  WalletAgeSummary,
  WalletBehaviorSummary,
  WalletCaseSummary,
  WalletDeFiSummary,
  WalletRiskSummary,
  WalletWhaleSummary,
} from "../types";

export function analyzeWalletCaseSummary(
  age: WalletAgeSummary,
  risk: WalletRiskSummary,
  whale: WalletWhaleSummary,
  defi: WalletDeFiSummary,
  behavior: WalletBehaviorSummary,
): WalletCaseSummary {
  const keyFindings: string[] = [];

  if (age.classification === "veteran") {
    keyFindings.push("Veteran wallet.");
  } else if (age.classification === "established") {
    keyFindings.push("Established wallet.");
  } else if (age.classification === "new") {
    keyFindings.push("Recently created wallet.");
  }

  keyFindings.push(`Risk level: ${risk.level}.`);

  if (whale.isWhale) {
    keyFindings.push("Large portfolio detected.");
  }

  if (defi.protocolCount > 0) {
    keyFindings.push(
      `Uses ${defi.protocolCount} recognized DeFi protocol(s).`,
    );
  }

  keyFindings.push(
    `Behavior profile: ${behavior.primaryProfile.replace(/_/g, " ")}.`,
  );

  let recommendation: WalletCaseSummary["recommendation"];

  if (risk.level === "high") {
    recommendation = "high_risk";
  } else if (risk.level === "medium") {
    recommendation = "investigate";
  } else if (behavior.primaryProfile === "new_wallet") {
    recommendation = "review";
  } else {
    recommendation = "allow";
  }

  const headline =
    behavior.primaryProfile === "unknown"
      ? "Wallet investigation completed"
      : `${behavior.primaryProfile
          .replace(/_/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase())}`;

  const executiveSummary =
    `This wallet is classified as ${behavior.primaryProfile.replace(
      /_/g,
      " ",
    )} with a ${risk.level} risk assessment. ` +
    `Recommendation: ${recommendation.replace(/_/g, " ")}.`;

  return {
    headline,
    executiveSummary,
    keyFindings,
    recommendation,
  };
}
