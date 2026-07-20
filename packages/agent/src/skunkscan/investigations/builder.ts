import { createInvestigation } from "./factory";
import {
  InvestigationCase,
  InvestigationEvidence,
  InvestigationSubject,
} from "./types";

export interface BuildWalletInvestigationInput {
  chain: string;
  address: string;
  walletAnalysis: unknown;
}

export function buildWalletInvestigation(
  input: BuildWalletInvestigationInput
): InvestigationCase {

  const investigation = createInvestigation({
    title: `Wallet Investigation - ${input.address}`,
    description: "Automatically generated wallet investigation.",
    createdBy: "SkunkScanAI",
    tags: ["wallet"],
  });

  const subject: InvestigationSubject = {
    id: "subject_wallet",
    type: "wallet",
    chain: input.chain as any,
    identifier: input.address,
    addedAt: new Date().toISOString(),
  };

  investigation.subjects.push(subject);

  const evidence: InvestigationEvidence = {
    id: "wallet_analysis",
    type: "wallet_profile",
    subjectId: subject.id,
    title: "Wallet Analysis",
    description: "Complete wallet intelligence collected.",
    source: "SkunkScanAI",
    collectedAt: new Date().toISOString(),
    confidence: "high",
    data: {
      analysis: input.walletAnalysis,
    },
  };

  investigation.evidence.push(evidence);

  return investigation;
}
