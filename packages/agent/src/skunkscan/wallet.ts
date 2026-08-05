import {
  getSolanaParsedTransactions,
} from "./helius";
import {
  EthereumTransaction,
  getEthereumOldestTransaction,
  getEthereumTransactions,
} from "./moralis";
import { requireBlockchainConnector } from "./chains/registry";
import { WRAPPED_NATIVE_ASSET_ID } from "./providers/priceProvider";
import { getTokenPriceProvider } from "./providers/pricing/registry";
import { createWalletInvestigation } from "./investigations/walletIntegration";
import { runWalletPipeline } from "./pipeline/walletPipeline";
import { parseSolanaTransaction } from "./parsers/transaction";
import { parseEthereumTransaction } from "./parsers/ethereumTransaction";
import {
  SupportedChain,
  UniversalNftHolding,
  WalletBalance,
  WalletInvestigationResult,
  WalletRecentTokenActivity,
  WalletRecentTransaction,
  WalletTokenHolding,
} from "./types";

const MAX_RECENT_TOKEN_ACTIVITY_ITEMS = 10;

// Fallback for when getTokenBalances can't enumerate a wallet's full
// token list (see the ETHEREUM_TOKEN_BALANCE_COUNT_EXCEEDS_PROVIDER_LIMIT
// warning) - derives "tokens seen in recent transfers" from the same
// rawTransactions already fetched for the transaction list, no extra API
// call. Deliberately NOT a balance/holdings computation - see
// WalletRecentTokenActivity's doc comment in types.ts.
function deriveRecentEthereumTokenActivity(
  walletAddress: string,
  rawTransactions: EthereumTransaction[],
): WalletRecentTokenActivity[] {
  const normalizedAddress = walletAddress.toLowerCase();
  const activityByContract = new Map<string, WalletRecentTokenActivity>();

  for (const transaction of rawTransactions) {
    for (const transfer of transaction.tokenTransfers) {
      const contractAddress = transfer.address;

      if (!contractAddress) {
        continue;
      }

      const from = transfer.from_address?.toLowerCase();
      const to = transfer.to_address?.toLowerCase();

      if (from !== normalizedAddress && to !== normalizedAddress) {
        continue;
      }

      const existing = activityByContract.get(contractAddress);
      const transactionTimestamp = transaction.blockTimestamp;

      if (
        existing &&
        existing.lastSeenAt !== null &&
        transactionTimestamp !== null &&
        existing.lastSeenAt >= transactionTimestamp
      ) {
        continue;
      }

      activityByContract.set(contractAddress, {
        contractAddress,
        symbol: transfer.token_symbol ?? null,
        name: transfer.token_name ?? null,
        lastSeenAmount:
          typeof transfer.value_formatted === "string"
            ? Number(transfer.value_formatted)
            : null,
        lastSeenDirection:
          to === normalizedAddress
            ? "receive"
            : from === normalizedAddress
              ? "send"
              : "unknown",
        lastSeenAt: transactionTimestamp,
        lastSeenTransactionId: transaction.hash,
      });
    }
  }

  return Array.from(activityByContract.values())
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
    .slice(0, MAX_RECENT_TOKEN_ACTIVITY_ITEMS);
}

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

// Helius hard-caps the Enhanced Transactions batch this feeds at 100
// (verified live), but unlike Moralis, Helius exposes no cost/credit
// signal in the response at any batch size - the per-call cost-scaling
// question stays genuinely unresolved, so this is a conservative bump
// rather than a jump to the ceiling.
const recentTransactionsResult =
  await connector.getTransactions(walletAddress, {
    limit: 75,
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
  transactionRisk,
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
transactionRisk,
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

    case "ethereum": {
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

        const rawWei = Number(nativeBalanceResult.data.rawAmount);
        const ethBalance = Number(
          nativeBalanceResult.data.decimalAmount ?? "0",
        );

        if (!Number.isFinite(rawWei) || !Number.isFinite(ethBalance)) {
          throw new Error(
            "The Ethereum connector returned an invalid balance.",
          );
        }

        // Fetched directly from moralis.ts rather than through
        // connector.getTransactions()/getOldestTransaction(): the
        // connector's Layer A wraps these same calls but discards
        // transfers into an empty array by design (see chains/ethereum.ts's
        // createUniversalTransaction) - going through it first would be a
        // wasted round trip producing throwaway data. Unlike Solana, Moralis
        // doesn't split "get IDs" from "get rich content" into separate
        // calls, so there's no equivalent bypass-and-refetch needed here.
        // Moralis hard-caps this endpoint at limit=100 (verified: limit=150+
        // returns a documented 400 "Limit has a maximum of 100"), at the
        // same flat 150 CU cost as limit=50 - confirmed via x-request-weight
        // on both sizes, so this is free headroom, not an added cost.
        const { transactions: rawTransactions } =
          await getEthereumTransactions(walletAddress, "eth", 100);

        const normalizedRecentParsedTransactions =
          rawTransactions.map(parseEthereumTransaction);

        const recentTransactions: WalletRecentTransaction[] =
          rawTransactions.map((transaction) => ({
            transactionId: transaction.hash,
            blockHeight: transaction.blockNumber ?? undefined,
            blockTime: transaction.blockTimestamp ?? undefined,
            status:
              transaction.status === "failed" ? "failed" : "success",
          }));

        const oldestTransaction =
          await getEthereumOldestTransaction(walletAddress, "eth");

        const firstParsedTransaction = parseEthereumTransaction(
          oldestTransaction,
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

        // A "partial" status (e.g. a wallet with too many distinct tokens
        // for Moralis's endpoint to enumerate) still has usable .data - the
        // warning explaining what's incomplete must reach the caller here,
        // not get silently discarded once .data.balances is extracted below.
        const investigationWarnings: string[] =
          tokenBalancesResult.warnings.map((warning) => warning.message);

        const tokenBalanceCountExceedsProviderLimit =
          tokenBalancesResult.warnings.some(
            (warning) =>
              warning.code ===
              "ETHEREUM_TOKEN_BALANCE_COUNT_EXCEEDS_PROVIDER_LIMIT",
          );

        // Supplementary fallback, not a replacement for tokenHoldings -
        // only derived when tokenHoldings is already known-incomplete.
        const recentTokenActivity = tokenBalanceCountExceedsProviderLimit
          ? deriveRecentEthereumTokenActivity(walletAddress, rawTransactions)
          : [];

        if (recentTokenActivity.length > 0) {
          investigationWarnings.push(
            `Showing ${recentTokenActivity.length} token(s) seen in recent activity (not a complete holdings list) as a fallback, since the full token list couldn't be retrieved for this wallet - these reflect recent transfers, not current balances, and may not represent the wallet's largest actual holdings.`,
          );
        }

        const tokenHoldings: WalletTokenHolding[] =
          tokenBalancesResult.data.balances.map((tokenBalance) => {
            const contractAddress = tokenBalance.asset.contractAddress;
            const decimals = tokenBalance.asset.decimals;
            const amount = Number(tokenBalance.decimalAmount ?? "0");

            if (!contractAddress) {
              throw new Error(
                "The Ethereum connector returned a token without a contract address.",
              );
            }

            if (
              typeof decimals !== "number" ||
              !Number.isInteger(decimals) ||
              decimals < 0
            ) {
              throw new Error(
                `The Ethereum connector returned invalid decimals for token "${contractAddress}".`,
              );
            }

            if (!Number.isFinite(amount)) {
              throw new Error(
                `The Ethereum connector returned an invalid amount for token "${contractAddress}".`,
              );
            }

            return {
              tokenId: contractAddress,
              amount,
              decimals,
              rawAmount: tokenBalance.rawAmount,
            };
          });

        // Same tolerance as Solana: a connector that omits getNftHoldings
        // (or a call that fails) degrades to an empty list rather than
        // failing the whole investigation.
        const nftHoldingsResult =
          await connector.getNftHoldings?.(walletAddress);

        const nftHoldings: UniversalNftHolding[] =
          nftHoldingsResult?.data?.holdings ?? [];

        // Neither WRAPPED_NATIVE_ASSET_ID nor the pricing registry has an
        // Ethereum entry yet (PR 6+) - both already degrade to "no prices"
        // rather than throwing.
        const nativeAssetId = WRAPPED_NATIVE_ASSET_ID[chain];
        const priceProvider = getTokenPriceProvider(chain);
        const tokenPrices = priceProvider
          ? await priceProvider.getTokenPrices([
              ...tokenHoldings.map((token) => token.tokenId),
              ...(nativeAssetId ? [nativeAssetId] : []),
            ])
          : {};

        const walletBalance: WalletBalance = {
          nativeAmount: ethBalance,
          nativeSymbol: "ETH",
          rawAmount: rawWei,
        };

        const pipeline = await runWalletPipeline({
          chain,
          address: walletAddress,
          balance: walletBalance,
          tokenHoldings,
          recentTransactions,
          oldestTransactionId: oldestTransaction?.hash,
          oldestTransactionTimestamp:
            oldestTransaction?.blockTimestamp ?? undefined,
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
          transactionRisk,
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
          recentTokenActivity:
            recentTokenActivity.length > 0 ? recentTokenActivity : undefined,
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
          transactionRisk,
          smartMoney,
          strategy,
          conviction,
          alpha,
          investmentStyle,
          profitability,
          reputation,
          skunkScore,
          summary: `Wallet found. Current balance: ${ethBalance.toFixed(
            6,
          )} ETH. Recent transaction sample: ${recentTransactions.length}.`,
          warnings: investigationWarnings,
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

    case "bnb": {
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

        const rawWei = Number(nativeBalanceResult.data.rawAmount);
        const bnbBalance = Number(
          nativeBalanceResult.data.decimalAmount ?? "0",
        );

        if (!Number.isFinite(rawWei) || !Number.isFinite(bnbBalance)) {
          throw new Error(
            "The BNB Smart Chain connector returned an invalid balance.",
          );
        }

        // Same rationale as the Ethereum branch: fetched directly from
        // moralis.ts rather than through connector.getTransactions(), which
        // discards transfers into an empty array by design (see
        // chains/bnb.ts's createUniversalTransaction). limit=100 was
        // carried over from Ethereum's already-bumped sample size when this
        // branch was first written, on the assumption that Moralis's
        // wallet-history endpoint behaves identically for chain=bsc as for
        // chain=eth - that assumption was confirmed correct in a dedicated
        // follow-up investigation (same hard cap at limit=100, same flat
        // 150 CU cost, both live-verified against chain=bsc specifically).
        const { transactions: rawTransactions } =
          await getEthereumTransactions(walletAddress, "bsc", 100);

        const normalizedRecentParsedTransactions =
          rawTransactions.map(parseEthereumTransaction);

        const recentTransactions: WalletRecentTransaction[] =
          rawTransactions.map((transaction) => ({
            transactionId: transaction.hash,
            blockHeight: transaction.blockNumber ?? undefined,
            blockTime: transaction.blockTimestamp ?? undefined,
            status:
              transaction.status === "failed" ? "failed" : "success",
          }));

        const oldestTransaction =
          await getEthereumOldestTransaction(walletAddress, "bsc");

        const firstParsedTransaction = parseEthereumTransaction(
          oldestTransaction,
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

        const investigationWarnings: string[] =
          tokenBalancesResult.warnings.map((warning) => warning.message);

        const tokenBalanceCountExceedsProviderLimit =
          tokenBalancesResult.warnings.some(
            (warning) =>
              warning.code ===
              "BNB_TOKEN_BALANCE_COUNT_EXCEEDS_PROVIDER_LIMIT",
          );

        // Supplementary fallback, not a replacement for tokenHoldings -
        // only derived when tokenHoldings is already known-incomplete.
        // deriveRecentEthereumTokenActivity is genuinely EVM-generic
        // despite its name (reshapes rawTransactions' tokenTransfers, no
        // Ethereum-specific logic) - reused as-is, same as
        // parseEthereumTransaction.
        const recentTokenActivity = tokenBalanceCountExceedsProviderLimit
          ? deriveRecentEthereumTokenActivity(walletAddress, rawTransactions)
          : [];

        if (recentTokenActivity.length > 0) {
          investigationWarnings.push(
            `Showing ${recentTokenActivity.length} token(s) seen in recent activity (not a complete holdings list) as a fallback, since the full token list couldn't be retrieved for this wallet - these reflect recent transfers, not current balances, and may not represent the wallet's largest actual holdings.`,
          );
        }

        const tokenHoldings: WalletTokenHolding[] =
          tokenBalancesResult.data.balances.map((tokenBalance) => {
            const contractAddress = tokenBalance.asset.contractAddress;
            const decimals = tokenBalance.asset.decimals;
            const amount = Number(tokenBalance.decimalAmount ?? "0");

            if (!contractAddress) {
              throw new Error(
                "The BNB Smart Chain connector returned a token without a contract address.",
              );
            }

            if (
              typeof decimals !== "number" ||
              !Number.isInteger(decimals) ||
              decimals < 0
            ) {
              throw new Error(
                `The BNB Smart Chain connector returned invalid decimals for token "${contractAddress}".`,
              );
            }

            if (!Number.isFinite(amount)) {
              throw new Error(
                `The BNB Smart Chain connector returned an invalid amount for token "${contractAddress}".`,
              );
            }

            return {
              tokenId: contractAddress,
              amount,
              decimals,
              rawAmount: tokenBalance.rawAmount,
            };
          });

        const nftHoldingsResult =
          await connector.getNftHoldings?.(walletAddress);

        const nftHoldings: UniversalNftHolding[] =
          nftHoldingsResult?.data?.holdings ?? [];

        // Neither WRAPPED_NATIVE_ASSET_ID nor the pricing registry has a
        // BNB entry yet - both already degrade to "no prices" rather than
        // throwing, same as Ethereum before its pricing entry existed.
        const nativeAssetId = WRAPPED_NATIVE_ASSET_ID[chain];
        const priceProvider = getTokenPriceProvider(chain);
        const tokenPrices = priceProvider
          ? await priceProvider.getTokenPrices([
              ...tokenHoldings.map((token) => token.tokenId),
              ...(nativeAssetId ? [nativeAssetId] : []),
            ])
          : {};

        const walletBalance: WalletBalance = {
          nativeAmount: bnbBalance,
          nativeSymbol: "BNB",
          rawAmount: rawWei,
        };

        const pipeline = await runWalletPipeline({
          chain,
          address: walletAddress,
          balance: walletBalance,
          tokenHoldings,
          recentTransactions,
          oldestTransactionId: oldestTransaction?.hash,
          oldestTransactionTimestamp:
            oldestTransaction?.blockTimestamp ?? undefined,
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
          transactionRisk,
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
          recentTokenActivity:
            recentTokenActivity.length > 0 ? recentTokenActivity : undefined,
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
          transactionRisk,
          smartMoney,
          strategy,
          conviction,
          alpha,
          investmentStyle,
          profitability,
          reputation,
          skunkScore,
          summary: `Wallet found. Current balance: ${bnbBalance.toFixed(
            6,
          )} BNB. Recent transaction sample: ${recentTransactions.length}.`,
          warnings: investigationWarnings,
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

    case "base": {
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

        const rawWei = Number(nativeBalanceResult.data.rawAmount);
        const ethBalance = Number(
          nativeBalanceResult.data.decimalAmount ?? "0",
        );

        if (!Number.isFinite(rawWei) || !Number.isFinite(ethBalance)) {
          throw new Error(
            "The Base connector returned an invalid balance.",
          );
        }

        // Same rationale as the Ethereum/BNB branches: fetched directly from
        // moralis.ts rather than through connector.getTransactions(), which
        // discards transfers into an empty array by design (see
        // chains/base.ts's createUniversalTransaction). Moralis's
        // wallet-history endpoint behaves identically for chain=base as for
        // chain=eth/bsc (same hard cap at limit=100, same flat 150 CU cost,
        // both live-verified against chain=base specifically), so the same
        // sample size applies here.
        const { transactions: rawTransactions } =
          await getEthereumTransactions(walletAddress, "base", 100);

        const normalizedRecentParsedTransactions =
          rawTransactions.map(parseEthereumTransaction);

        const recentTransactions: WalletRecentTransaction[] =
          rawTransactions.map((transaction) => ({
            transactionId: transaction.hash,
            blockHeight: transaction.blockNumber ?? undefined,
            blockTime: transaction.blockTimestamp ?? undefined,
            status:
              transaction.status === "failed" ? "failed" : "success",
          }));

        const oldestTransaction =
          await getEthereumOldestTransaction(walletAddress, "base");

        const firstParsedTransaction = parseEthereumTransaction(
          oldestTransaction,
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

        const investigationWarnings: string[] =
          tokenBalancesResult.warnings.map((warning) => warning.message);

        const tokenBalanceCountExceedsProviderLimit =
          tokenBalancesResult.warnings.some(
            (warning) =>
              warning.code ===
              "BASE_TOKEN_BALANCE_COUNT_EXCEEDS_PROVIDER_LIMIT",
          );

        // Supplementary fallback, not a replacement for tokenHoldings -
        // only derived when tokenHoldings is already known-incomplete.
        // deriveRecentEthereumTokenActivity is genuinely EVM-generic
        // despite its name (reshapes rawTransactions' tokenTransfers, no
        // Ethereum-specific logic) - reused as-is, same as
        // parseEthereumTransaction.
        const recentTokenActivity = tokenBalanceCountExceedsProviderLimit
          ? deriveRecentEthereumTokenActivity(walletAddress, rawTransactions)
          : [];

        if (recentTokenActivity.length > 0) {
          investigationWarnings.push(
            `Showing ${recentTokenActivity.length} token(s) seen in recent activity (not a complete holdings list) as a fallback, since the full token list couldn't be retrieved for this wallet - these reflect recent transfers, not current balances, and may not represent the wallet's largest actual holdings.`,
          );
        }

        const tokenHoldings: WalletTokenHolding[] =
          tokenBalancesResult.data.balances.map((tokenBalance) => {
            const contractAddress = tokenBalance.asset.contractAddress;
            const decimals = tokenBalance.asset.decimals;
            const amount = Number(tokenBalance.decimalAmount ?? "0");

            if (!contractAddress) {
              throw new Error(
                "The Base connector returned a token without a contract address.",
              );
            }

            if (
              typeof decimals !== "number" ||
              !Number.isInteger(decimals) ||
              decimals < 0
            ) {
              throw new Error(
                `The Base connector returned invalid decimals for token "${contractAddress}".`,
              );
            }

            if (!Number.isFinite(amount)) {
              throw new Error(
                `The Base connector returned an invalid amount for token "${contractAddress}".`,
              );
            }

            return {
              tokenId: contractAddress,
              amount,
              decimals,
              rawAmount: tokenBalance.rawAmount,
            };
          });

        const nftHoldingsResult =
          await connector.getNftHoldings?.(walletAddress);

        const nftHoldings: UniversalNftHolding[] =
          nftHoldingsResult?.data?.holdings ?? [];

        // Neither WRAPPED_NATIVE_ASSET_ID nor the pricing registry has a
        // Base entry yet - both already degrade to "no prices" rather than
        // throwing, same as Ethereum/BNB before their pricing entries
        // existed.
        const nativeAssetId = WRAPPED_NATIVE_ASSET_ID[chain];
        const priceProvider = getTokenPriceProvider(chain);
        const tokenPrices = priceProvider
          ? await priceProvider.getTokenPrices([
              ...tokenHoldings.map((token) => token.tokenId),
              ...(nativeAssetId ? [nativeAssetId] : []),
            ])
          : {};

        const walletBalance: WalletBalance = {
          nativeAmount: ethBalance,
          nativeSymbol: "ETH",
          rawAmount: rawWei,
        };

        const pipeline = await runWalletPipeline({
          chain,
          address: walletAddress,
          balance: walletBalance,
          tokenHoldings,
          recentTransactions,
          oldestTransactionId: oldestTransaction?.hash,
          oldestTransactionTimestamp:
            oldestTransaction?.blockTimestamp ?? undefined,
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
          transactionRisk,
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
          recentTokenActivity:
            recentTokenActivity.length > 0 ? recentTokenActivity : undefined,
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
          transactionRisk,
          smartMoney,
          strategy,
          conviction,
          alpha,
          investmentStyle,
          profitability,
          reputation,
          skunkScore,
          summary: `Wallet found. Current balance: ${ethBalance.toFixed(
            6,
          )} ETH. Recent transaction sample: ${recentTransactions.length}.`,
          warnings: investigationWarnings,
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
