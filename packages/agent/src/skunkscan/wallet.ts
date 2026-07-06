import {
  getSolanaBalance,
  getSolanaOldestKnownSignature,
  getSolanaParsedTransactions,
  getSolanaRecentSignatures,
  getSolanaTokenHoldings,
} from "./helius";
import { analyzeWalletActivity } from "./analyzers/activity";
import { analyzeWalletRisk } from "./analyzers/risk";
import { analyzeWalletAge } from "./analyzers/walletAge";
import { analyzeWalletFunding } from "./analyzers/funding";
import {
  SupportedChain,
  WalletBalance,
  WalletInvestigationResult,
  WalletRecentTransaction,
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

const recentSignatures = await getSolanaRecentSignatures(
  walletAddress,
  10,
);

const oldestKnownSignature = await getSolanaOldestKnownSignature(
  walletAddress,
);

const parsedTransactions =
  oldestKnownSignature.signature
    ? await getSolanaParsedTransactions([
        oldestKnownSignature.signature,
      ])
    : [];

const firstParsedTransaction =
  parsedTransactions.length > 0
    ? parsedTransactions[0]
    : null;

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
       const activity = analyzeWalletActivity(recentTransactions);
        const age = analyzeWalletAge(
  oldestKnownSignature.signature,
  oldestKnownSignature.blockTime,
);

        const funding = analyzeWalletFunding(
  chain,
  walletAddress,
  firstParsedTransaction,
);

const risk = analyzeWalletRisk(
  balance.sol,
  activity,
);

        return {
          chain,
          address: walletAddress,
          status: "supported",
         balance: walletBalance,
tokenHoldings,
recentTransactions,
transactionCountSample: recentTransactions.length,
activity,
age,
funding,
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
