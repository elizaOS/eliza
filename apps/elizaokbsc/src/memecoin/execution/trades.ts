import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type BuyResult,
  DEFAULT_ADDRESSES,
  FourMemeTrader,
} from "@meme-sdk/trade";
import { ethers } from "ethers";
import type {
  DiscoveryConfig,
  ExecutionState,
  PortfolioLifecycle,
  PortfolioPosition,
  ScoredCandidate,
  TradeLedger,
  TradeRecord,
} from "../types";
import { evaluateKolSupport } from "./kol";
import { warmPublicKolWallets } from "./public-kol";

interface ExecuteTradeLaneArgs {
  runId: string;
  generatedAt: string;
  config: DiscoveryConfig;
  candidates: ScoredCandidate[];
  portfolioLifecycle: PortfolioLifecycle;
  executionState: ExecutionState;
  reportsDir: string;
}

type PreflightResult =
  | { ok: true; route: "fourmeme" | "pancakeswap" }
  | { ok: false; reason: string };

interface SellIntent {
  position: PortfolioPosition;
  reason: string;
  tokenAmountRaw: bigint;
  tokenAmount: string;
}

const HELPER3_READ_ABI = [
  "function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)",
  "function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)",
] as const;

const PANCAKE_READ_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
] as const;

function candidateReferenceUsd(candidate: ScoredCandidate): number | null {
  if (candidate.fdvUsd && candidate.fdvUsd > 0) return candidate.fdvUsd;
  if (candidate.reserveUsd > 0) return candidate.reserveUsd;
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function stringifyForLedger(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, currentValue) =>
      typeof currentValue === "bigint" ? currentValue.toString() : currentValue,
    2,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyLedger(): TradeLedger {
  return {
    records: [],
    lastUpdatedAt: null,
    totalExecutedBnb: 0,
    totalDryRunBnb: 0,
  };
}

function tradesPathFor(reportsDir: string): string {
  return path.isAbsolute(reportsDir)
    ? path.join(reportsDir, "trades.json")
    : path.join(process.cwd(), reportsDir, "trades.json");
}

export async function loadTradeLedger(
  reportsDir: string,
): Promise<TradeLedger> {
  try {
    const content = await readFile(tradesPathFor(reportsDir), "utf8");
    const parsed = JSON.parse(content) as TradeLedger;
    return {
      records: parsed.records || [],
      lastUpdatedAt: parsed.lastUpdatedAt || null,
      totalExecutedBnb: parsed.totalExecutedBnb || 0,
      totalDryRunBnb: parsed.totalDryRunBnb || 0,
    };
  } catch {
    return emptyLedger();
  }
}

function isSameUtcDay(leftIso: string, rightIso: string): boolean {
  return leftIso.slice(0, 10) === rightIso.slice(0, 10);
}

function hasRecentDryRunForToken(
  ledger: TradeLedger,
  tokenAddress: string,
  generatedAt: string,
  cooldownMs: number,
): boolean {
  if (cooldownMs <= 0) return false;

  const currentTime = Date.parse(generatedAt);
  if (!Number.isFinite(currentTime)) return false;

  return ledger.records.some((record) => {
    if (record.disposition !== "dry_run") return false;
    if (record.tokenAddress !== tokenAddress) return false;

    const recordTime = Date.parse(record.generatedAt);
    if (!Number.isFinite(recordTime)) return false;

    return currentTime - recordTime < cooldownMs;
  });
}

function createTrader(config: DiscoveryConfig["execution"]): FourMemeTrader {
  if (!config.rpcUrl || !config.privateKey) {
    throw new Error(
      "Four.meme SDK requires both ELIZAOK_BSC_RPC_URL and ELIZAOK_EXECUTION_PRIVATE_KEY.",
    );
  }

  return new FourMemeTrader({
    rpcUrl: config.rpcUrl,
    privateKey: config.privateKey,
  });
}

function createExecutionWallet(
  config: DiscoveryConfig["execution"],
): ethers.Wallet {
  if (!config.rpcUrl || !config.privateKey) {
    throw new Error(
      "Execution preflight requires both ELIZAOK_BSC_RPC_URL and ELIZAOK_EXECUTION_PRIVATE_KEY.",
    );
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl, {
    name: "bsc",
    chainId: 56,
  });
  return new ethers.Wallet(config.privateKey, provider);
}

async function preflightTradeRoute(
  config: DiscoveryConfig["execution"],
  tokenAddress: string,
  fundsWei: bigint,
): Promise<PreflightResult> {
  try {
    const wallet = createExecutionWallet(config);
    const helper3 = new ethers.Contract(
      DEFAULT_ADDRESSES.HELPER3,
      HELPER3_READ_ABI,
      wallet,
    );
    const tryPancakeFallback = async (
      reasonPrefix: string,
    ): Promise<PreflightResult> => {
      try {
        const router = new ethers.Contract(
          DEFAULT_ADDRESSES.PANCAKE_ROUTER,
          PANCAKE_READ_ABI,
          wallet,
        );
        await router.getAmountsOut(fundsWei, [
          DEFAULT_ADDRESSES.WBNB,
          tokenAddress,
        ]);
        return { ok: true, route: "pancakeswap" };
      } catch (error) {
        return {
          ok: false,
          reason: `${reasonPrefix} Pancake fallback rejected token: ${errorMessage(error)}`,
        };
      }
    };

    const tokenInfo = (await helper3.getTokenInfo(tokenAddress)) as readonly [
      bigint,
      string,
      string,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
    ];
    const tokenManager = tokenInfo[1];
    const liquidityAdded = tokenInfo[11];

    if (!tokenManager || tokenManager === ethers.ZeroAddress) {
      return tryPancakeFallback(
        "Helper3 returned no token manager for this token.",
      );
    }

    if (!liquidityAdded) {
      try {
        await helper3.tryBuy(tokenAddress, 0n, fundsWei);
        return { ok: true, route: "fourmeme" };
      } catch (error) {
        return tryPancakeFallback(
          `Four.meme preflight rejected token: ${errorMessage(error)}`,
        );
      }
    }

    return tryPancakeFallback("Liquidity has migrated.");
  } catch (error) {
    return {
      ok: false,
      reason: `Trade route preflight failed: ${errorMessage(error)}`,
    };
  }
}

async function preflightSellRoute(
  config: DiscoveryConfig["execution"],
  tokenAddress: string,
  tokenAmountRaw: bigint,
): Promise<
  | {
      ok: true;
      route: "fourmeme" | "pancakeswap";
      quoteBnb: number;
      quoteUsd: number;
    }
  | { ok: false; reason: string }
> {
  try {
    const wallet = createExecutionWallet(config);
    const helper3 = new ethers.Contract(
      DEFAULT_ADDRESSES.HELPER3,
      HELPER3_READ_ABI,
      wallet,
    );
    const tryPancakeFallback = async (reasonPrefix: string) => {
      try {
        const router = new ethers.Contract(
          DEFAULT_ADDRESSES.PANCAKE_ROUTER,
          PANCAKE_READ_ABI,
          wallet,
        );
        const amounts = (await router.getAmountsOut(tokenAmountRaw, [
          tokenAddress,
          DEFAULT_ADDRESSES.WBNB,
        ])) as bigint[];
        const out = amounts[amounts.length - 1] ?? 0n;
        const quoteBnb = Number(ethers.formatEther(out));
        return {
          ok: true as const,
          route: "pancakeswap" as const,
          quoteBnb,
          quoteUsd: Math.round(
            quoteBnb *
              Number.parseFloat(
                process.env.ELIZAOK_TEST_BNB_USD_PRICE || "600",
              ),
          ),
        };
      } catch (error) {
        return {
          ok: false as const,
          reason: `${reasonPrefix} Pancake sell preflight rejected token: ${errorMessage(error)}`,
        };
      }
    };

    const tokenInfo = (await helper3.getTokenInfo(tokenAddress)) as readonly [
      bigint,
      string,
      string,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
    ];
    const tokenManager = tokenInfo[1];
    const liquidityAdded = tokenInfo[11];

    if (!tokenManager || tokenManager === ethers.ZeroAddress) {
      return tryPancakeFallback(
        "Helper3 returned no token manager for this token.",
      );
    }

    if (!liquidityAdded) {
      try {
        const [, , funds, fee] = (await helper3.trySell(
          tokenAddress,
          tokenAmountRaw,
        )) as readonly [string, string, bigint, bigint];
        const netFunds = funds > fee ? funds - fee : 0n;
        const quoteBnb = Number(ethers.formatEther(netFunds));
        return {
          ok: true,
          route: "fourmeme",
          quoteBnb,
          quoteUsd: Math.round(
            quoteBnb *
              Number.parseFloat(
                process.env.ELIZAOK_TEST_BNB_USD_PRICE || "600",
              ),
          ),
        };
      } catch (error) {
        return tryPancakeFallback(
          `Four.meme sell preflight rejected token: ${errorMessage(error)}`,
        );
      }
    }

    return tryPancakeFallback("Liquidity has migrated.");
  } catch (error) {
    return {
      ok: false,
      reason: `Sell route preflight failed: ${errorMessage(error)}`,
    };
  }
}

async function executeSdkBuy(
  trader: FourMemeTrader,
  route: "fourmeme" | "pancakeswap",
  tokenAddress: string,
  bnbAmount: number,
): Promise<{ result: BuyResult; route: "fourmeme" | "pancakeswap" }> {
  try {
    const result =
      route === "pancakeswap"
        ? await trader.buyPancakeToken(tokenAddress, bnbAmount)
        : await trader.buyToken(tokenAddress, bnbAmount);

    return { result, route };
  } catch (error) {
    const message = errorMessage(error);
    if (
      !message.includes("REPLACEMENT_UNDERPRICED") &&
      !message.includes("replacement fee too low")
    ) {
      throw error;
    }

    // Retry once after a short pause in case the RPC/node had a stale pending nonce view.
    await sleep(3000);
    const result =
      route === "pancakeswap"
        ? await trader.buyPancakeToken(tokenAddress, bnbAmount)
        : await trader.buyToken(tokenAddress, bnbAmount);

    return { result, route };
  }
}

async function executeSdkSell(
  trader: FourMemeTrader,
  route: "fourmeme" | "pancakeswap",
  tokenAddress: string,
  tokenAmount: number,
): Promise<{
  txHash: string;
  gasUsed: string;
  route: "fourmeme" | "pancakeswap";
}> {
  const result =
    route === "pancakeswap"
      ? await trader.sellPancakeToken(tokenAddress, tokenAmount)
      : await trader.sellToken(tokenAddress, tokenAmount);

  return { ...result, route };
}

function buildSellIntent(
  position: PortfolioPosition,
  candidate: ScoredCandidate | undefined,
  treasury: DiscoveryConfig["treasury"],
): SellIntent | null {
  if (
    position.executionSource !== "live" &&
    position.executionSource !== "hybrid"
  )
    return null;
  if (position.state !== "active") return null;
  if (position.walletVerification !== "present") return null;
  const tokenDecimals = normalizeTokenDecimals(
    position.walletTokenDecimals as number | string | null,
  );
  if (!position.walletTokenBalance || tokenDecimals === null) return null;

  const rawBalance = ethers.parseUnits(
    position.walletTokenBalance,
    tokenDecimals,
  );
  if (rawBalance <= 0n) return null;

  for (const rule of treasury.takeProfitRules) {
    if (position.takeProfitStagesHit.includes(rule.label)) continue;
    if (position.unrealizedPnlPct < rule.gainPct) continue;
    const tokenAmountRaw = (rawBalance * BigInt(rule.sellPct)) / 100n;
    if (tokenAmountRaw <= 0n) continue;
    return {
      position,
      reason: `${rule.label} live take-profit triggered.`,
      tokenAmountRaw,
      tokenAmount: ethers.formatUnits(tokenAmountRaw, tokenDecimals),
    };
  }

  if (position.unrealizedPnlPct <= treasury.stopLossPct) {
    return {
      position,
      reason: `Live stop loss triggered at ${position.unrealizedPnlPct}%.`,
      tokenAmountRaw: rawBalance,
      tokenAmount: position.walletTokenBalance,
    };
  }

  if (!candidate || candidate.score <= treasury.exitScoreThreshold) {
    return {
      position,
      reason: `Live exit triggered because the current signal fell below the treasury floor.`,
      tokenAmountRaw: rawBalance,
      tokenAmount: position.walletTokenBalance,
    };
  }

  if (
    candidate.recommendation === "observe" ||
    candidate.recommendation === "reject"
  ) {
    return {
      position,
      reason: `Live exit triggered because the candidate was downgraded to ${candidate.recommendation}.`,
      tokenAmountRaw: rawBalance,
      tokenAmount: position.walletTokenBalance,
    };
  }

  return null;
}

function createTradeRecord(
  base: Omit<TradeRecord, "id">,
  ledger: TradeLedger,
): TradeLedger {
  const record: TradeRecord = {
    id: randomUUID(),
    ...base,
  };

  const records = [record, ...ledger.records].slice(0, 200);
  return {
    records,
    lastUpdatedAt: base.generatedAt,
    totalExecutedBnb:
      ledger.totalExecutedBnb +
      (record.disposition === "executed" ? record.plannedBuyBnb : 0),
    totalDryRunBnb:
      ledger.totalDryRunBnb +
      (record.disposition === "dry_run" ? record.plannedBuyBnb : 0),
  };
}

function normalizeTokenDecimals(
  value: number | string | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function executeTradeLane({
  runId,
  generatedAt,
  config,
  candidates,
  portfolioLifecycle,
  executionState,
  reportsDir,
}: ExecuteTradeLaneArgs): Promise<{
  executionState: ExecutionState;
  tradeLedger: TradeLedger;
}> {
  let tradeLedger = await loadTradeLedger(reportsDir);
  const candidateMap = new Map(
    candidates.map((candidate) => [candidate.tokenAddress, candidate]),
  );
  const plans = executionState.plans.map((plan) => ({ ...plan }));
  const preflightMap = new Map<string, PreflightResult>();
  if (
    config.execution.kol.enabled &&
    config.execution.kol.publicSourceEnabled &&
    !config.execution.kol.walletsPath
  ) {
    await warmPublicKolWallets(
      config.execution,
      candidates
        .slice(0, config.execution.kol.publicSourceTokenLimit)
        .map((candidate) => candidate.tokenAddress),
    );
  }
  for (const plan of plans) {
    if (!plan.eligible) continue;
    const kolSupport = await evaluateKolSupport(
      config.execution,
      plan.tokenAddress,
    );
    plan.kolSupport = kolSupport;
    if (!kolSupport.qualified) {
      plan.eligible = false;
      plan.routeTradable = "blocked";
      plan.routeReason = kolSupport.reason;
      plan.reasons = [
        ...plan.reasons.filter(
          (reason) => !reason.includes("tracked KOL wallets"),
        ),
        kolSupport.reason,
      ];
    } else if (kolSupport.enabled) {
      plan.reasons = [...plan.reasons, kolSupport.reason];
    }
  }
  for (const plan of plans) {
    if (!plan.eligible) {
      plan.routeTradable = "blocked";
      plan.routeReason = plan.reasons[0] || "Blocked by strategy gates.";
      plan.resolvedRoute = null;
      continue;
    }

    const fundsWei = ethers.parseUnits(plan.plannedBuyBnb.toFixed(8), 18);
    const preflight = await preflightTradeRoute(
      config.execution,
      plan.tokenAddress,
      fundsWei,
    );
    preflightMap.set(plan.tokenAddress, preflight);
    if (preflight.ok) {
      plan.routeTradable = "tradable";
      plan.routeReason = `Tradable via ${preflight.route}.`;
      plan.resolvedRoute = preflight.route;
    } else {
      plan.routeTradable = "blocked";
      plan.routeReason = preflight.reason;
      plan.resolvedRoute = null;
    }
  }

  const eligiblePlans = plans.filter((plan) => plan.eligible);
  const tradableEligiblePlans = eligiblePlans.filter(
    (plan) => plan.routeTradable === "tradable",
  );
  const blockedEligiblePlans = eligiblePlans.filter(
    (plan) => plan.routeTradable === "blocked",
  );
  const executedTodayBnb = tradeLedger.records
    .filter(
      (record) =>
        record.disposition === "executed" &&
        isSameUtcDay(record.generatedAt, generatedAt),
    )
    .reduce((sum, record) => sum + record.plannedBuyBnb, 0);

  const cycleSummary = {
    consideredCount: plans.length,
    eligibleCount: eligiblePlans.length,
    attemptedCount: 0,
    dryRunCount: 0,
    executedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    note: "Execution lane evaluated, but no trade action was necessary.",
  };
  const gooLane = executionState.gooLane;

  if (!config.execution.enabled) {
    return {
      executionState: {
        ...executionState,
        cycleSummary: { ...cycleSummary, note: "Execution is disabled." },
      },
      tradeLedger,
    };
  }

  if (config.execution.mode === "paper") {
    return {
      executionState: {
        ...executionState,
        cycleSummary: {
          ...cycleSummary,
          note: "Execution mode is paper, so no live buy attempts were made.",
        },
      },
      tradeLedger,
    };
  }

  if (!config.execution.dryRun && !config.execution.liveConfirmArmed) {
    return {
      executionState: {
        ...executionState,
        cycleSummary: {
          ...cycleSummary,
          note: `Live execution is blocked until ELIZAOK_EXECUTION_LIVE_CONFIRM matches ${config.execution.liveConfirmPhrase}.`,
        },
      },
      tradeLedger,
    };
  }

  if (!executionState.configured) {
    return {
      executionState: {
        ...executionState,
        cycleSummary: {
          ...cycleSummary,
          note: "Execution is enabled, but readiness checks are incomplete.",
        },
      },
      tradeLedger,
    };
  }

  if (config.execution.router !== "fourmeme") {
    return {
      executionState: {
        ...executionState,
        cycleSummary: {
          ...cycleSummary,
          note: `Router ${config.execution.router} is not implemented yet for live buy execution.`,
        },
      },
      tradeLedger,
    };
  }

  let activeSlots = portfolioLifecycle.activePositions.length;
  let dailySpentBnb = executedTodayBnb;
  const effectiveDailyDeployBnb = Math.max(
    0,
    config.execution.risk.maxDailyDeployBnb - (gooLane?.reserveBnb ?? 0),
  );
  let bnbUsdPrice: number | null = null;
  let trader: FourMemeTrader | null = null;
  const sellCandidateMap = new Map(
    candidates.map((candidate) => [candidate.tokenAddress, candidate]),
  );

  if (config.execution.mode === "live_full") {
    for (const position of portfolioLifecycle.activePositions) {
      const sellIntent = buildSellIntent(
        position,
        sellCandidateMap.get(position.tokenAddress),
        config.treasury,
      );
      if (!sellIntent) continue;

      cycleSummary.attemptedCount += 1;
      const sellPreflight = await preflightSellRoute(
        config.execution,
        position.tokenAddress,
        sellIntent.tokenAmountRaw,
      );

      if (!sellPreflight.ok) {
        cycleSummary.skippedCount += 1;
        cycleSummary.note = sellPreflight.reason;
        tradeLedger = createTradeRecord(
          {
            runId,
            generatedAt,
            side: "sell",
            router: config.execution.router,
            mode: config.execution.mode,
            tokenAddress: position.tokenAddress,
            tokenSymbol: position.tokenSymbol,
            plannedBuyBnb: 0,
            plannedBuyUsd: 0,
            fundsBnb: null,
            fundsWei: null,
            tokenAmount: sellIntent.tokenAmount,
            quoteBnb: null,
            quoteUsd: null,
            disposition: "skipped",
            reason: sellPreflight.reason,
            command: `sdk:sell-auto-route ${position.tokenAddress} ${sellIntent.tokenAmount}`,
          },
          tradeLedger,
        );
        continue;
      }

      if (config.execution.dryRun) {
        cycleSummary.dryRunCount += 1;
        tradeLedger = createTradeRecord(
          {
            runId,
            generatedAt,
            side: "sell",
            router: config.execution.router,
            mode: config.execution.mode,
            tokenAddress: position.tokenAddress,
            tokenSymbol: position.tokenSymbol,
            plannedBuyBnb: sellPreflight.quoteBnb,
            plannedBuyUsd: sellPreflight.quoteUsd,
            fundsBnb: null,
            fundsWei: null,
            tokenAmount: sellIntent.tokenAmount,
            quoteBnb: sellPreflight.quoteBnb,
            quoteUsd: sellPreflight.quoteUsd,
            disposition: "dry_run",
            reason: `${sellIntent.reason} Dry-run is enabled, so no on-chain sell was sent.`,
            command: `sdk:sell-auto-route ${position.tokenAddress} ${sellIntent.tokenAmount}`,
          },
          tradeLedger,
        );
        continue;
      }

      try {
        trader ??= createTrader(config.execution);
        const sellResult = await executeSdkSell(
          trader,
          sellPreflight.route,
          position.tokenAddress,
          Number.parseFloat(sellIntent.tokenAmount),
        );
        cycleSummary.executedCount += 1;
        tradeLedger = createTradeRecord(
          {
            runId,
            generatedAt,
            side: "sell",
            router: config.execution.router,
            mode: config.execution.mode,
            tokenAddress: position.tokenAddress,
            tokenSymbol: position.tokenSymbol,
            plannedBuyBnb: sellPreflight.quoteBnb,
            plannedBuyUsd: sellPreflight.quoteUsd,
            fundsBnb: null,
            fundsWei: null,
            tokenAmount: sellIntent.tokenAmount,
            quoteBnb: sellPreflight.quoteBnb,
            quoteUsd: sellPreflight.quoteUsd,
            disposition: "executed",
            reason: `${sellIntent.reason} SDK sell completed successfully via ${sellResult.route}.`,
            command: `sdk:sell-auto-route ${position.tokenAddress} ${sellIntent.tokenAmount}`,
            stdout: stringifyForLedger({
              gasUsed: sellResult.gasUsed,
            }),
            stderr: "",
            txHash: sellResult.txHash,
          },
          tradeLedger,
        );
      } catch (error) {
        cycleSummary.failedCount += 1;
        tradeLedger = createTradeRecord(
          {
            runId,
            generatedAt,
            side: "sell",
            router: config.execution.router,
            mode: config.execution.mode,
            tokenAddress: position.tokenAddress,
            tokenSymbol: position.tokenSymbol,
            plannedBuyBnb: 0,
            plannedBuyUsd: 0,
            fundsBnb: null,
            fundsWei: null,
            tokenAmount: sellIntent.tokenAmount,
            quoteBnb: null,
            quoteUsd: null,
            disposition: "failed",
            reason: errorMessage(error),
            command: `sdk:sell-auto-route ${position.tokenAddress} ${sellIntent.tokenAmount}`,
          },
          tradeLedger,
        );
      }
    }
  }

  if (gooLane?.blocksMemecoinBuys) {
    return {
      executionState: {
        ...executionState,
        plans,
        cycleSummary: {
          ...cycleSummary,
          skippedCount: tradableEligiblePlans.length,
          note: gooLane.note,
        },
      },
      tradeLedger,
    };
  }

  for (const plan of tradableEligiblePlans.slice(
    0,
    config.execution.maxBuysPerCycle,
  )) {
    const candidate = candidateMap.get(plan.tokenAddress);
    if (!candidate) {
      cycleSummary.skippedCount += 1;
      cycleSummary.attemptedCount += 1;
      tradeLedger = createTradeRecord(
        {
          runId,
          generatedAt,
          router: config.execution.router,
          mode: config.execution.mode,
          tokenAddress: plan.tokenAddress,
          tokenSymbol: plan.tokenSymbol,
          plannedBuyBnb: plan.plannedBuyBnb,
          fundsBnb: null,
          fundsWei: null,
          disposition: "skipped",
          reason: "Candidate disappeared before execution could start.",
        },
        tradeLedger,
      );
      continue;
    }

    if (
      config.execution.dryRun &&
      hasRecentDryRunForToken(
        tradeLedger,
        candidate.tokenAddress,
        generatedAt,
        config.execution.dryRunCooldownMs,
      )
    ) {
      cycleSummary.skippedCount += 1;
      cycleSummary.note =
        "Dry-run cooldown suppressed a duplicate preview for the same token.";
      continue;
    }

    if (activeSlots >= config.execution.risk.maxActivePositions) {
      cycleSummary.skippedCount += 1;
      cycleSummary.attemptedCount += 1;
      tradeLedger = createTradeRecord(
        {
          runId,
          generatedAt,
          router: config.execution.router,
          mode: config.execution.mode,
          tokenAddress: candidate.tokenAddress,
          tokenSymbol: candidate.tokenSymbol,
          plannedBuyBnb: plan.plannedBuyBnb,
          fundsBnb: null,
          fundsWei: null,
          disposition: "skipped",
          reason: "Max active position limit is already reached.",
        },
        tradeLedger,
      );
      continue;
    }

    if (dailySpentBnb + plan.plannedBuyBnb > effectiveDailyDeployBnb) {
      cycleSummary.skippedCount += 1;
      cycleSummary.attemptedCount += 1;
      tradeLedger = createTradeRecord(
        {
          runId,
          generatedAt,
          router: config.execution.router,
          mode: config.execution.mode,
          tokenAddress: candidate.tokenAddress,
          tokenSymbol: candidate.tokenSymbol,
          plannedBuyBnb: plan.plannedBuyBnb,
          fundsBnb: null,
          fundsWei: null,
          disposition: "skipped",
          reason:
            gooLane?.reserveBnb && gooLane.reserveBnb > 0
              ? `Daily BNB deployment cap would be exceeded after reserving ${gooLane.reserveBnb.toFixed(4)} BNB for Goo.`
              : "Daily BNB deployment cap would be exceeded by this trade.",
        },
        tradeLedger,
      );
      continue;
    }

    if (
      tradeLedger.records.some(
        (record) =>
          record.tokenAddress === candidate.tokenAddress &&
          record.disposition === "executed" &&
          record.mode !== "paper",
      )
    ) {
      cycleSummary.skippedCount += 1;
      cycleSummary.attemptedCount += 1;
      tradeLedger = createTradeRecord(
        {
          runId,
          generatedAt,
          router: config.execution.router,
          mode: config.execution.mode,
          tokenAddress: candidate.tokenAddress,
          tokenSymbol: candidate.tokenSymbol,
          plannedBuyBnb: plan.plannedBuyBnb,
          fundsBnb: null,
          fundsWei: null,
          disposition: "skipped",
          reason: "Token already has a previously executed live buy on record.",
        },
        tradeLedger,
      );
      continue;
    }

    cycleSummary.attemptedCount += 1;

    try {
      bnbUsdPrice ??= Number.parseFloat(
        process.env.ELIZAOK_TEST_BNB_USD_PRICE || "600",
      );
      const plannedBuyUsd = Math.round(plan.plannedBuyBnb * bnbUsdPrice);
      const entryReferenceUsd = candidateReferenceUsd(candidate);
      const fundsBnb = plan.plannedBuyBnb;
      const fundsBnbFormatted = fundsBnb.toFixed(8);
      const fundsWei = ethers.parseUnits(fundsBnbFormatted, 18).toString();
      const command = `sdk:buy-auto-route ${candidate.tokenAddress} ${plan.plannedBuyBnb.toFixed(8)} BNB`;
      const preflight = preflightMap.get(candidate.tokenAddress) ?? {
        ok: false as const,
        reason: "Missing route preflight result.",
      };

      if (!preflight.ok) {
        cycleSummary.skippedCount += 1;
        cycleSummary.note = preflight.reason;
        tradeLedger = createTradeRecord(
          {
            runId,
            generatedAt,
            router: config.execution.router,
            mode: config.execution.mode,
            tokenAddress: candidate.tokenAddress,
            tokenSymbol: candidate.tokenSymbol,
            plannedBuyBnb: plan.plannedBuyBnb,
            plannedBuyUsd,
            bnbUsdPrice,
            entryReferenceUsd,
            fundsBnb: null,
            fundsWei,
            disposition: "skipped",
            reason: preflight.reason,
            command,
          },
          tradeLedger,
        );
        continue;
      }

      if (config.execution.dryRun) {
        cycleSummary.dryRunCount += 1;
        tradeLedger = createTradeRecord(
          {
            runId,
            generatedAt,
            side: "buy",
            router: config.execution.router,
            mode: config.execution.mode,
            tokenAddress: candidate.tokenAddress,
            tokenSymbol: candidate.tokenSymbol,
            plannedBuyBnb: plan.plannedBuyBnb,
            plannedBuyUsd,
            bnbUsdPrice,
            entryReferenceUsd,
            fundsBnb,
            fundsWei,
            disposition: "dry_run",
            reason: "Dry-run is enabled, so no on-chain order was sent.",
            command,
          },
          tradeLedger,
        );
        continue;
      }
      trader ??= createTrader(config.execution);
      const { result, route } = await executeSdkBuy(
        trader,
        preflight.route,
        candidate.tokenAddress,
        plan.plannedBuyBnb,
      );
      cycleSummary.executedCount += 1;
      activeSlots += 1;
      dailySpentBnb += plan.plannedBuyBnb;
      tradeLedger = createTradeRecord(
        {
          runId,
          generatedAt,
          side: "buy",
          router: config.execution.router,
          mode: config.execution.mode,
          tokenAddress: candidate.tokenAddress,
          tokenSymbol: candidate.tokenSymbol,
          plannedBuyBnb: plan.plannedBuyBnb,
          plannedBuyUsd,
          bnbUsdPrice,
          entryReferenceUsd,
          fundsBnb,
          fundsWei,
          tokenAmount:
            result.estimatedTokens != null
              ? String(result.estimatedTokens)
              : null,
          disposition: "executed",
          reason: `SDK buy completed successfully via ${route}.`,
          command,
          stdout: stringifyForLedger({
            estimatedTokens: result.estimatedTokens,
            gasUsed: result.gasUsed,
            duration: result.duration,
          }),
          stderr: "",
          txHash: result.txHash,
        },
        tradeLedger,
      );
    } catch (error) {
      cycleSummary.failedCount += 1;
      tradeLedger = createTradeRecord(
        {
          runId,
          generatedAt,
          side: "buy",
          router: config.execution.router,
          mode: config.execution.mode,
          tokenAddress: candidate.tokenAddress,
          tokenSymbol: candidate.tokenSymbol,
          plannedBuyBnb: plan.plannedBuyBnb,
          fundsBnb: null,
          fundsWei: null,
          disposition: "failed",
          reason:
            error instanceof Error
              ? error.message
              : "Unknown trade execution error.",
        },
        tradeLedger,
      );
    }
  }

  const note =
    cycleSummary.executedCount > 0
      ? "At least one live buy command completed successfully."
      : cycleSummary.dryRunCount > 0
        ? "Execution lane produced dry-run trade previews."
        : cycleSummary.failedCount > 0
          ? "Execution lane attempted live buys, but at least one trade failed."
          : blockedEligiblePlans.length > 0 &&
              tradableEligiblePlans.length === 0
            ? `All ${blockedEligiblePlans.length} strategy-eligible candidates failed route tradability checks.`
            : tradableEligiblePlans.length > 0 && cycleSummary.skippedCount > 0
              ? cycleSummary.note
              : tradableEligiblePlans.length > 0
                ? `Found ${tradableEligiblePlans.length} route-tradable candidates, but none were executed in this cycle.`
                : cycleSummary.skippedCount > 0
                  ? cycleSummary.note
                  : cycleSummary.note;

  return {
    executionState: {
      ...executionState,
      plans,
      cycleSummary: {
        ...cycleSummary,
        note,
      },
    },
    tradeLedger,
  };
}
