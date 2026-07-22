import { ProtocolAnalysis } from "./protocols";

export interface ProtocolIntelligence {
  primaryProtocol: string | null;
  primaryCategory: string | null;

  activeProtocols: number;

  protocolDiversity: "none" | "low" | "medium" | "high";

  dominantProtocolShare: number;

  investorProfile:
    | "Inactive"
    | "Basic User"
    | "DEX Trader"
    | "Multi-Protocol DeFi User";

  confidence: "low" | "medium" | "high";
}

export function analyzeProtocolIntelligence(
  analysis: ProtocolAnalysis,
): ProtocolIntelligence {
  if (analysis.protocols.length === 0) {
    return {
      primaryProtocol: null,
      primaryCategory: null,
      activeProtocols: 0,
      protocolDiversity: "none",
      dominantProtocolShare: 0,
      investorProfile: "Inactive",
      confidence: "low",
    };
  }

  const totalInteractions = analysis.protocols.reduce(
    (sum, protocol) => sum + protocol.interactionCount,
    0,
  );

  const primary = analysis.protocols[0];

  const dominantProtocolShare =
    totalInteractions === 0
      ? 0
      : Math.round(
          (primary.interactionCount / totalInteractions) * 100,
        );

  let protocolDiversity: ProtocolIntelligence["protocolDiversity"];

  if (analysis.totalProtocols <= 1) {
    protocolDiversity = "low";
  } else if (analysis.totalProtocols <= 3) {
    protocolDiversity = "medium";
  } else {
    protocolDiversity = "high";
  }

  let investorProfile: ProtocolIntelligence["investorProfile"];

  if (analysis.totalProtocols === 0) {
    investorProfile = "Inactive";
  } else if (analysis.totalProtocols === 1) {
    investorProfile = "Basic User";
  } else if (primary.protocol.category === "dex") {
    investorProfile = "DEX Trader";
  } else {
    investorProfile = "Multi-Protocol DeFi User";
  }

  return {
    primaryProtocol: primary.protocol.name,
    primaryCategory: primary.protocol.category,
    activeProtocols: analysis.totalProtocols,
    protocolDiversity,
    dominantProtocolShare,
    investorProfile,
    confidence:
      analysis.verifiedProtocols === analysis.totalProtocols
        ? "high"
        : "medium",
  };
}
