import { SupportedChain } from "../types";
import { WalletPipelineResult } from "../pipeline/types";

import { buildWalletInvestigation } from "./builder";
import { InvestigationCase } from "./types";

export interface CreateWalletInvestigationInput {
  chain: SupportedChain;
  address: string;
  walletAnalysis: WalletPipelineResult;
}

export function createWalletInvestigation(
  input: CreateWalletInvestigationInput,
): InvestigationCase {
  return buildWalletInvestigation({
    chain: input.chain,
    address: input.address,
    walletAnalysis: input.walletAnalysis,
  });
}
