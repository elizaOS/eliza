import { SupportedChain } from "../types";
import { WalletPipelineResult } from "../pipeline/types";

import { createInvestigation } from "./factory";
import {
  InvestigationCase,
  InvestigationEvidence,
  InvestigationSubject,
  InvestigationChain,
} from "./types";

export interface BuildWalletInvestigationInput {
  chain: SupportedChain;
  address: string;
  walletAnalysis: WalletPipelineResult;
}

export function buildWalletInvestigation(
  input: BuildWalletInvestigationInput
): InvestigationCase {
  const investigation = createInvestigation({
    title: `Wallet Investigation - ${input.address}`,
    description: "Automatically generated wallet investigation.",
    createdBy: "SkunkScanAI",
    tags: ["wallet"],
    origin: "api",
  });

  const subject: InvestigationSubject = {
    id: "subject_wallet",
    type: "wallet",
    chain: input.chain as InvestigationChain,
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
