import {
  getSolanaBalance,
  getSolanaRecentSignatures,
  getSolanaTokenHoldings,
} from "./helius";
import {
  SupportedChain,
  WalletActivitySummary,
  WalletBalance,
  WalletInvestigationResult,
  WalletRecentTransaction,
  WalletRiskSummary,
  WalletTokenHolding,
} from "./types";

export async function investigateWallet(
  chain: SupportedChain,
  address: string,
): Promise<WalletInvestigationResult> {
  const walletAddress = address.trim();

  if (!walletAddress) {
    return {
      chain,
      address: "",
      status: "invalid_address",
      summary: "No wallet address was provided.",
      warnings: ["Wallet address is empty."],
    };
  }

  switch (chain) {
    case "solana": {
      try {
        const balance = await getSolanaBalance(walletAddress);
        const recentSignatures = await getSolanaRecentSignatures(walletAddress, 10);
        const tokenHoldings = await getSolanaTokenHoldings(walletAddress);

        const walletBalance: WalletBalance = {
          nativeAmount: balance.sol,
          nativeSymbol: "SOL",
          rawAmount: balance.lamports,
        };
        const recentTransactions: WalletRecentTransaction[] =
  recentSignatures.map((tx) => ({
    signature: String(tx.signature ?? ""),
    slot: typeof tx.slot === "number" ? tx.slot : undefined,
    blockTime:
      typeof tx.blockTime === "number" || tx.blockTime === null
        ? tx.blockTime
        : undefined,
    status: tx.err ? "failed" : "success",
  }));
        const failedTransactionCount = recentTransactions.filter(
  (tx) => tx.status === "failed",
).length;

const lastActiveAt =
  recentTransactions.length > 0 ? recentTransactions[0].blockTime : null;

const activityLevel =
  recentTransactions.length === 0
    ? "none"
    : recentTransactions.length <= 3
      ? "low"
      : recentTransactions.length <= 10
        ? "medium"
        : "high";

const activity: WalletActivitySummary = {
  recentTransactionCount: recentTransactions.length,
  failedTransactionCount,
  lastActiveAt,
  activityLevel,
};

const riskReasons: string[] = [];
let riskScore = 0;

if (balance.sol === 0) {
  riskScore += 5;
  riskReasons.push("Wallet currently has zero SOL balance.");
}

if (failedTransactionCount > 0) {
  riskScore += Math.min(failedTransactionCount * 10, 30);
  riskReasons.push(
    `${failedTransactionCount} failed transaction(s) found in the recent sample.`,
  );
}

if (recentTransactions.length === 0) {
  riskScore += 10;
  riskReasons.push("No recent transaction activity found.");
} else {
  riskReasons.push("Wallet has recent transaction activity.");
}

if (riskReasons.length === 0) {
  riskReasons.push("No obvious risk signals found in the current sample.");
}

const riskLevel =
  riskScore >= 60 ? "high" : riskScore >= 25 ? "medium" : "low";

const risk: WalletRiskSummary = {
  score: riskScore,
  level: riskLevel,
  reasons: riskReasons,
};

        return {
          chain,
          address: walletAddress,
          status: "supported",
         balance: walletBalance,
tokenHoldings,
recentTransactions,
transactionCountSample: recentTransactions.length,
activity,
risk,
summary: `Wallet found. Current balance: ${balance.sol.toFixed(
  6,
)} SOL. Recent transaction sample: ${recentTransactions.length}.`,
warnings: [],
        };
      } catch (error) {
        return {
          chain,
          address: walletAddress,
          status: "error",
          summary: "Unable to investigate this wallet.",
          warnings: [
            error instanceof Error
              ? error.message
              : "Unknown investigation error.",
          ],
        };
      }
    }

    case "ethereum":
    case "base":
    case "bnb":
      return {
        chain,
        address: walletAddress,
        status: "unsupported_chain",
        summary: `${chain.toUpperCase()} investigation is not available yet.`,
        warnings: [
          `${chain.toUpperCase()} support will be added in a future release.`,
        ],
      };

    default:
      return {
        chain,
        address: walletAddress,
        status: "unsupported_chain",
        summary: "Unsupported blockchain.",
        warnings: ["Unknown chain."],
      };
  }
}
