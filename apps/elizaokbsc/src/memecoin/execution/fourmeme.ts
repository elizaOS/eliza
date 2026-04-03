import type { ExecutionConfig, ExecutionState, ScoredCandidate } from "../types";

export interface FourMemeCommandPreview {
  command: string;
  description: string;
}

export interface FourMemeAdapterPreview {
  enabled: boolean;
  route: ExecutionConfig["router"];
  mode: ExecutionConfig["mode"];
  nextAction: string;
  commands: FourMemeCommandPreview[];
}

function quoteBuyCommand(candidate: ScoredCandidate, config: ExecutionConfig): FourMemeCommandPreview {
  return {
    command: `sdk:getMigrationStatus("${candidate.tokenAddress}")`,
    description: `Check whether ${candidate.tokenSymbol} is still on Four.meme or has migrated to PancakeSwap.`,
  };
}

function buyCommand(candidate: ScoredCandidate, config: ExecutionConfig): FourMemeCommandPreview {
  return {
    command: `sdk:${config.mode === "live_buy_only" || config.mode === "live_full" ? "buyToken/buyPancakeToken" : "buy-preview"}("${candidate.tokenAddress}", ${config.risk.maxBuyBnb})`,
    description: `Execute a routed SDK buy for ${candidate.tokenSymbol} with ${config.risk.maxBuyBnb} BNB once safeguards allow it.`,
  };
}

export function buildFourMemeAdapterPreview(
  config: ExecutionConfig,
  executionState: ExecutionState,
  candidates: ScoredCandidate[]
): FourMemeAdapterPreview {
  const primary = candidates.find((candidate) => candidate.recommendation === "simulate_buy");
  const commands: FourMemeCommandPreview[] = [];

  if (primary) {
    commands.push(quoteBuyCommand(primary, config));
    commands.push(buyCommand(primary, config));
  }

  return {
    enabled: config.router === "fourmeme",
    route: config.router,
    mode: config.mode,
    nextAction:
      config.router !== "fourmeme"
        ? "Execution router is not fourmeme."
        : executionState.liveTradingArmed
          ? "Four.meme SDK lane is configured and can route buys through Four.meme or PancakeSwap based on migration state."
          : executionState.nextAction,
    commands,
  };
}
