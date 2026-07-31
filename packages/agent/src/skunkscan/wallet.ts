import {
  getSolanaParsedTransactions,
} from "./helius";
import { requireBlockchainConnector } from "./chains/registry";
import { WRAPPED_NATIVE_ASSET_ID } from "./providers/priceProvider";
import { getTokenPriceProvider } from "./providers/pricing/registry";
import { createWalletInvestigation } from "./investigations/walletIntegration";
import { runWalletPipeline } from "./pipeline/walletPipeline";
import { parseSolanaTransaction } from "./parsers/transaction";
import {
  SupportedChain,
  UniversalNftHolding,
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
        const connector = requireBlockchainConnector(chain);

const nativeBalanceResult =
  await connector.getNativeBalance(walletAddress);

if (
  nativeBalanceResult.status === "error" ||
  nativeBalanceResult.status === "unsupported" ||
  !nativeBalanceResult.data
) {
  throw new Error(
    nativeBalanceResult.error?.message ??
      "Unable to retrieve the wallet native balance.",
  );
}

const rawLamports = Number(
  nativeBalanceResult.data.rawAmount,
);

const solBalance = Number(
  nativeBalanceResult.data.decimalAmount ?? "0",
);

if (
  !Number.isFinite(rawLamports) ||
  !Number.isFinite(solBalance)
) {
  throw new Error(
    "The Solana connector returned an invalid balance.",
  );
}

const balance = {
  address: nativeBalanceResult.data.address,
  lamports: rawLamports,
  sol: solBalance,
};

const recentTransactionsResult =
  await connector.getTransactions(walletAddress, {
    limit: 50,
  });

if (
  recentTransactionsResult.status === "error" ||
  recentTransactionsResult.status === "unsupported" ||
  !recentTransactionsResult.data
) {
  throw new Error(
    recentTransactionsResult.error?.message ??
      "Unable to retrieve the wallet transactions.",
  );
}

const recentParsedTransactions =
  await getSolanaParsedTransactions(
    recentTransactionsResult.data.transactions.map(
      (transaction) => transaction.transactionId,
    ),
  );

// Normalized 1:1 — same elements, same order, same count. Every
// analyzer downstream consumes this chain-neutral shape.
const normalizedRecentParsedTransactions =
  recentParsedTransactions.map(parseSolanaTransaction);

if (!connector.getOldestTransaction) {
  throw new Error(
    "The blockchain connector does not support oldest transaction retrieval.",
  );
}

const oldestTransactionResult =
  await connector.getOldestTransaction(
    walletAddress,
  );

if (
  oldestTransactionResult.status === "error" ||
  oldestTransactionResult.status === "unsupported" ||
  !oldestTransactionResult.data
) {
  throw new Error(
    oldestTransactionResult.error?.message ??
      "Unable to retrieve the wallet oldest transaction.",
  );
}

const oldestKnownTransaction =
  oldestTransactionResult.data;

const oldestParsedTransactions =
  oldestKnownTransaction.transactionId
    ? await getSolanaParsedTransactions([
        oldestKnownTransaction.transactionId,
      ])
    : [];

const firstParsedTransaction = parseSolanaTransaction(
  oldestParsedTransactions.length > 0
    ? oldestParsedTransactions[0]
    : null,
);

const tokenBalancesResult =
  await connector.getTokenBalances(walletAddress);

if (
  tokenBalancesResult.status === "error" ||
  tokenBalancesResult.status === "unsupported" ||
  !tokenBalancesResult.data
) {
  throw new Error(
    tokenBalancesResult.error?.message ??
      "Unable to retrieve the wallet token balances.",
  );
}

const tokenHoldings: WalletTokenHolding[] =
  tokenBalancesResult.data.balances.map(
    (tokenBalance) => {
      const mint =
        tokenBalance.asset.contractAddress;

      const decimals =
        tokenBalance.asset.decimals;

      const amount = Number(
        tokenBalance.decimalAmount ?? "0",
      );

      if (!mint) {
        throw new Error(
          "The Solana connector returned a token without a mint address.",
        );
      }

      if (
        typeof decimals !== "number" ||
        !Number.isInteger(decimals) ||
        decimals < 0
      ) {
        throw new Error(
          `The Solana connector returned invalid decimals for token "${mint}".`,
        );
      }

      if (!Number.isFinite(amount)) {
        throw new Error(
          `The Solana connector returned an invalid amount for token "${mint}".`,
        );
      }

      return {
        tokenId: mint,
        amount,
        decimals,
        rawAmount: tokenBalance.rawAmount,
      };
    },
  );

// NFT holdings are supplementary display data, not analyzed by any
// downstream analyzer, so a connector that omits getNftHoldings (or a
// call that fails) degrades to an empty list rather than failing the
// whole investigation - the same tolerance the old chain-name check had.
const nftHoldingsResult =
  await connector.getNftHoldings?.(walletAddress);

const nftHoldings: UniversalNftHolding[] =
  nftHoldingsResult?.data?.holdings ?? [];

        const nativeAssetId = WRAPPED_NATIVE_ASSET_ID[chain];
        const priceProvider = getTokenPriceProvider(chain);
        const tokenPrices = priceProvider
          ? await priceProvider.getTokenPrices([
              ...tokenHoldings.map((token) => token.tokenId),
              ...(nativeAssetId ? [nativeAssetId] : []),
            ])
          : {};

        const walletBalance: WalletBalance = {
          nativeAmount: balance.sol,
          nativeSymbol: "SOL",
          rawAmount: balance.lamports,
        };
        const recentTransactions: WalletRecentTransaction[] =
  recentTransactionsResult.data.transactions.map(
    (transaction) => ({
      transactionId: transaction.transactionId,
      blockHeight:
        transaction.blockHeight ?? undefined,
      blockTime:
        transaction.timestamp ?? undefined,
      status:
        transaction.status === "failed"
          ? "failed"
          : "success",
    }),
  );
       const pipeline = await runWalletPipeline({
  chain,
  address: walletAddress,
  balance: walletBalance,
  tokenHoldings,
  recentTransactions,
  oldestTransactionId:
    oldestKnownTransaction.transactionId,
  oldestTransactionTimestamp:
    oldestKnownTransaction.timestamp,
  firstParsedTransaction,
  normalizedRecentParsedTransactions,
  tokenPrices,
});

const {
  activity,
  age,
  funding,
  portfolio,
  risk,
  whale,
  defi,
  protocols,
  protocolIntelligence,
  behavior,
  exposure,
  relationships,
  custodyProfile,
  complianceScreening,
  intelligenceSources,
  trust,
  display,
  transactionRiskAssessment,
  smartMoney,
  strategy,
  conviction,
  alpha,
  investmentStyle,
  profitability,
  reputation,
  skunkScore,
  investigationReplay,
  evidenceRecords,
  assessment,
  intelligenceBrief,
  evidence,
  executiveVerdict,
} = pipeline;
        
  const investigation = createWalletInvestigation({
  chain,
  address: walletAddress,
  executiveVerdict,
  assessment,
  intelligenceBrief,
  evidence,
  evidenceRecords,
  risk,
  trust,
  portfolio,
  whale,
  funding,
  activity,
});

void investigation;
        
        return {
  chain,
  address: walletAddress,
  status: "supported",
  balance: walletBalance,
  tokenHoldings,
  portfolio,
  nftHoldings,
  whale,
  defi,
  protocols,
  protocolIntelligence,
  behavior,
  exposure,
relationships,
display,
assessment,
intelligenceBrief,
custodyProfile,
complianceScreening,
intelligenceSources,
trust,
investigationReplay,
evidence,
evidenceRecords,
recentTransactions,
transactionCountSample: recentTransactions.length,
activity,
age,
funding,
risk,
transactionRisk:
  transactionRiskAssessment,
smartMoney,
strategy,
conviction,
alpha,
investmentStyle,
profitability,
reputation,
skunkScore,
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
