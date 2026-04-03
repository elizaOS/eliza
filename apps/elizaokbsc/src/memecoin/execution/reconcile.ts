import { ethers } from "ethers";
import type { ExecutionConfig, PortfolioLifecycle, PortfolioPosition } from "../types";

const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
] as const;

const HELPER3_READ_ABI = [
  "function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)",
  "function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 funds, uint256 fee)",
] as const;

const PANCAKE_READ_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
] as const;

const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const HELPER3_ADDRESS = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034";
const PANCAKE_ROUTER_ADDRESS = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

function bnbUsdPrice(): number {
  return Number.parseFloat(process.env.ELIZAOK_TEST_BNB_USD_PRICE || "600");
}

async function quoteTokenValue(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  rawBalance: bigint
): Promise<{ route: "fourmeme" | "pancakeswap"; quoteBnb: number; quoteUsd: number } | null> {
  if (rawBalance <= 0n) {
    return { route: "fourmeme", quoteBnb: 0, quoteUsd: 0 };
  }

  const helper3 = new ethers.Contract(HELPER3_ADDRESS, HELPER3_READ_ABI, provider);
  try {
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

    if (tokenManager && tokenManager !== ethers.ZeroAddress && !liquidityAdded) {
      const [, , funds, fee] = (await helper3.trySell(tokenAddress, rawBalance)) as readonly [
        string,
        string,
        bigint,
        bigint,
      ];
      const netFunds = funds > fee ? funds - fee : 0n;
      const quoteBnb = Number(ethers.formatEther(netFunds));
      return {
        route: "fourmeme",
        quoteBnb,
        quoteUsd: Math.round(quoteBnb * bnbUsdPrice()),
      };
    }
  } catch {
    // Fall through to Pancake quote.
  }

  try {
    const router = new ethers.Contract(PANCAKE_ROUTER_ADDRESS, PANCAKE_READ_ABI, provider);
    const amounts = (await router.getAmountsOut(rawBalance, [tokenAddress, WBNB_ADDRESS])) as bigint[];
    const out = amounts[amounts.length - 1] ?? 0n;
    const quoteBnb = Number(ethers.formatEther(out));
    return {
      route: "pancakeswap",
      quoteBnb,
      quoteUsd: Math.round(quoteBnb * bnbUsdPrice()),
    };
  } catch {
    return null;
  }
}

async function reconcilePositionBalance(
  provider: ethers.JsonRpcProvider,
  walletAddress: string,
  position: PortfolioPosition,
  generatedAt: string
): Promise<PortfolioPosition> {
  try {
    const contract = new ethers.Contract(position.tokenAddress, ERC20_BALANCE_ABI, provider);
    const [rawBalance, decimalsRaw] = (await Promise.all([
      contract.balanceOf(walletAddress),
      contract.decimals(),
    ])) as [bigint, number | bigint];
    const decimals = Number(decimalsRaw);

    const formattedBalance = ethers.formatUnits(rawBalance, decimals);
    const quote = await quoteTokenValue(provider, position.tokenAddress, rawBalance);
    const currentValueUsd =
      quote && (position.executionSource === "live" || position.executionSource === "hybrid")
        ? quote.quoteUsd
        : position.currentValueUsd;
    const fullyExited = rawBalance === 0n && position.allocationUsd <= 0;
    const unrealizedPnlUsd = fullyExited ? 0 : currentValueUsd - position.allocationUsd;
    const unrealizedPnlPct =
      !fullyExited && position.allocationUsd > 0
        ? Math.round(((unrealizedPnlUsd / position.allocationUsd) * 100) * 10) / 10
        : 0;

    return {
      ...position,
      state: fullyExited ? "exited" : position.state,
      exitReason: fullyExited ? position.exitReason ?? "Wallet balance is empty after live exit." : position.exitReason,
      walletVerification: rawBalance > 0n ? "present" : "empty",
      walletTokenBalance: formattedBalance,
      walletTokenDecimals: decimals,
      walletCheckedAt: generatedAt,
      walletQuoteRoute: quote?.route ?? null,
      walletQuoteBnb: quote?.quoteBnb ?? null,
      walletQuoteUsd: quote?.quoteUsd ?? null,
      currentValueUsd: fullyExited ? 0 : currentValueUsd,
      unrealizedPnlUsd,
      unrealizedPnlPct,
    };
  } catch {
    return {
      ...position,
      walletVerification: "error",
      walletTokenBalance: null,
      walletTokenDecimals: null,
      walletCheckedAt: generatedAt,
      walletQuoteRoute: null,
      walletQuoteBnb: null,
      walletQuoteUsd: null,
    };
  }
}

function summarizeVerification(positions: PortfolioPosition[]): string | null {
  const target = positions.filter(
    (position) => position.executionSource === "live" || position.executionSource === "hybrid"
  );
  if (target.length === 0) return null;

  const present = target.filter((position) => position.walletVerification === "present").length;
  const empty = target.filter((position) => position.walletVerification === "empty").length;
  const errored = target.filter((position) => position.walletVerification === "error").length;
  return `Wallet reconciliation checked ${target.length} live-linked positions: ${present} present, ${empty} empty, ${errored} errors.`;
}

export async function reconcilePortfolioWithWallet(params: {
  portfolio: PortfolioLifecycle;
  execution: ExecutionConfig;
  generatedAt: string;
}): Promise<PortfolioLifecycle> {
  const { portfolio, execution, generatedAt } = params;
  if (!execution.rpcUrl || !execution.walletAddress) {
    return portfolio;
  }

  const provider = new ethers.JsonRpcProvider(execution.rpcUrl);
  const reconcile = async (position: PortfolioPosition) => {
    if (position.executionSource !== "live" && position.executionSource !== "hybrid") {
      return position;
    }
    return reconcilePositionBalance(provider, execution.walletAddress!, position, generatedAt);
  };

  const [activePositions, watchPositions, exitedPositions] = await Promise.all([
    Promise.all(portfolio.activePositions.map(reconcile)),
    Promise.all(portfolio.watchPositions.map(reconcile)),
    Promise.all(portfolio.exitedPositions.map(reconcile)),
  ]);

  const verificationSummary = summarizeVerification([
    ...activePositions,
    ...watchPositions,
    ...exitedPositions,
  ]);

  const allPositions = [...activePositions, ...watchPositions, ...exitedPositions];
  const normalizedActive = allPositions
    .filter((position) => position.state === "active")
    .sort((a, b) => b.currentScore - a.currentScore);
  const normalizedWatch = allPositions
    .filter((position) => position.state === "watch")
    .sort((a, b) => b.currentScore - a.currentScore);
  const normalizedExited = allPositions
    .filter((position) => position.state === "exited")
    .sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt));
  const totalAllocatedUsd = normalizedActive.reduce((sum, position) => sum + position.allocationUsd, 0);
  const totalCurrentValueUsd = normalizedActive.reduce((sum, position) => sum + position.currentValueUsd, 0);
  const totalRealizedPnlUsd = allPositions.reduce((sum, position) => sum + position.realizedPnlUsd, 0);
  const totalUnrealizedPnlUsd = normalizedActive.reduce((sum, position) => sum + position.unrealizedPnlUsd, 0);
  const totalUnrealizedPnlPct =
    totalAllocatedUsd > 0 ? Math.round(((totalUnrealizedPnlUsd / totalAllocatedUsd) * 100) * 10) / 10 : 0;

  return {
    ...portfolio,
    activePositions: normalizedActive,
    watchPositions: normalizedWatch,
    exitedPositions: normalizedExited,
    totalAllocatedUsd,
    totalCurrentValueUsd,
    totalRealizedPnlUsd,
    totalUnrealizedPnlUsd,
    totalUnrealizedPnlPct,
    grossPortfolioValueUsd: portfolio.cashBalanceUsd + totalCurrentValueUsd + portfolio.reservedUsd,
    healthNote: verificationSummary
      ? `${portfolio.healthNote} ${verificationSummary}`
      : portfolio.healthNote,
  };
}
