import { buildWalletInvestigation } from "./builder";
import { InvestigationCase } from "./types";

export interface CreateWalletInvestigationInput {
  chain: string;
  address: string;
  executiveVerdict: unknown;
  assessment: unknown;
  intelligenceBrief: unknown;
  evidence: unknown;
  evidenceRecords: unknown;
  risk: unknown;
  trust: unknown;
  portfolio: unknown;
  whale: unknown;
  funding: unknown;
  activity: unknown;
}

export function createWalletInvestigation(
  input: CreateWalletInvestigationInput,
): InvestigationCase {
  return buildWalletInvestigation({
    chain: input.chain,
    address: input.address,
    walletAnalysis: {
      executiveVerdict: input.executiveVerdict,
      assessment: input.assessment,
      intelligenceBrief: input.intelligenceBrief,
      evidence: input.evidence,
      evidenceRecords: input.evidenceRecords,
      risk: input.risk,
      trust: input.trust,
      portfolio: input.portfolio,
      whale: input.whale,
      funding: input.funding,
      activity: input.activity,
    },
  });
}
