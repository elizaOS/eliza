import {
  getSolanaParsedTransactions,
} from "./helius";
import {
  EthereumTransaction,
  getEthereumOldestTransaction,
  getEthereumTransactions,
  isLikelySpamNftTransaction,
} from "./moralis";
import { requireBlockchainConnector } from "./chains/registry";
// deriveAddresses isn't part of the shared BlockchainConnector interface
// (see chains/bitcoin.ts) - it's an extra, Bitcoin-specific capability, so
// it needs the concrete class, not the generic connector returned by
// requireBlockchainConnector().
import { bitcoinBlockchainConnector } from "./chains/bitcoin";
import { getBitcoinTransactionsDetailed } from "./blockchair";
import { WRAPPED_NATIVE_ASSET_ID } from "./providers/priceProvider";
import { getTokenPriceProvider } from "./providers/pricing/registry";
import { createWalletInvestigation } from "./investigations/walletIntegration";
import { runWalletPipeline } from "./pipeline/walletPipeline";
import {
  parseSolanaTransaction,
  ParsedWalletTransaction,
} from "./parsers/transaction";
import { parseEthereumTransaction } from "./parsers/ethereumTransaction";
import { parseBitcoinTransaction } from "./parsers/bitcoinTransaction";
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

// Bitcoin-specific: how many transactions to LIST (recentTransactions/
// transactionCountSample/activityLevel) vs. actually PARSE with real
// inputs/outputs (funding/relationships/exposure). Deliberately different
// sizes - see the pagination design investigation and the comment at this
// branch's connector.getTransactions() call.
const TRANSACTION_LIST_LIMIT = 1000;
const TRANSACTIONS_TO_PARSE_LIMIT = 100;

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

// Shared by all three EVM branches (ethereum/bnb/base). Classifies each
// fetched transaction's likelySpam via isLikelySpamNftTransaction
// (Moralis's possible_spam flag OR null-address-mint - see moralis.ts for
// why verified_collection/category/multi-sender counting were tested and
// rejected). recentTransactions keeps every transaction, spam included -
// nothing is hidden from callers reading the full list (nftHoldings,
// evidence records, etc. are untouched by this entirely). Only
// nonSpamRecentTransactions - the one thing that feeds
// transactionCountSample/activityLevel/scoring - excludes them.
function buildEvmRecentTransactions(rawTransactions: EthereumTransaction[]): {
  recentTransactions: WalletRecentTransaction[];
  nonSpamRecentTransactions: WalletRecentTransaction[];
  spamNftTransactionCount: number;
} {
  const recentTransactions: WalletRecentTransaction[] = rawTransactions.map(
    (transaction) => ({
      transactionId: transaction.hash,
      blockHeight: transaction.blockNumber ?? undefined,
      blockTime: transaction.blockTimestamp ?? undefined,
      status: transaction.status === "failed" ? "failed" : "success",
      likelySpam: isLikelySpamNftTransaction(transaction),
    }),
  );

  const nonSpamRecentTransactions = recentTransactions.filter(
    (transaction) => !transaction.likelySpam,
  );

  return {
    recentTransactions,
    nonSpamRecentTransactions,
    spamNftTransactionCount:
      recentTransactions.length - nonSpamRecentTransactions.length,
  };
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

// No spam-NFT filter for Solana yet (see helius.ts for the two signals
// tested and rejected, both with real false positives). Unlike EVM chains,
// this sample and activityLevel are not filtered at all, so this is
// disclosed unconditionally rather than only when spam is detected.
const investigationWarnings: string[] = [
  "This wallet's transaction sample and activity level include any NFT spam/airdrop transactions - unlike Ethereum/BSC/Base, which filter known spam patterns out of the sample, Solana has no filter applied yet. This isn't an oversight: two candidate signals were tested against real spam and real legitimate wallets and both produced false positives on genuine, wanted NFTs, so nothing was shipped rather than risk hiding real activity.",
  ...tokenBalancesResult.warnings.map((warning) => warning.message),
];

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

        const {
          recentTransactions,
          nonSpamRecentTransactions,
          spamNftTransactionCount,
        } = buildEvmRecentTransactions(rawTransactions);

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

        if (spamNftTransactionCount > 0) {
          investigationWarnings.push(
            `${spamNftTransactionCount} likely spam/airdrop NFT transaction(s) were excluded from the activity sample used for transactionCountSample/activityLevel (still visible in the full recentTransactions list below, each flagged with likelySpam: true). This filter catches known patterns (Moralis's own spam flag, plus NFTs minted directly from the null address) - it does not catch all forms of NFT spam, such as mass-distribution campaigns disguised as legitimate marketplace activity.`,
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

        investigationWarnings.push(
          ...(nftHoldingsResult?.warnings ?? []).map(
            (warning) => warning.message,
          ),
        );

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
          recentTransactions: nonSpamRecentTransactions,
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
          transactionCountSample: nonSpamRecentTransactions.length,
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
          )} ETH. Recent transaction sample: ${nonSpamRecentTransactions.length}.`,
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

        const {
          recentTransactions,
          nonSpamRecentTransactions,
          spamNftTransactionCount,
        } = buildEvmRecentTransactions(rawTransactions);

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

        if (spamNftTransactionCount > 0) {
          investigationWarnings.push(
            `${spamNftTransactionCount} likely spam/airdrop NFT transaction(s) were excluded from the activity sample used for transactionCountSample/activityLevel (still visible in the full recentTransactions list below, each flagged with likelySpam: true). This filter catches known patterns (Moralis's own spam flag, plus NFTs minted directly from the null address) - it does not catch all forms of NFT spam, such as mass-distribution campaigns disguised as legitimate marketplace activity.`,
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

        investigationWarnings.push(
          ...(nftHoldingsResult?.warnings ?? []).map(
            (warning) => warning.message,
          ),
        );

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
          recentTransactions: nonSpamRecentTransactions,
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
          transactionCountSample: nonSpamRecentTransactions.length,
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
          )} BNB. Recent transaction sample: ${nonSpamRecentTransactions.length}.`,
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

        const {
          recentTransactions,
          nonSpamRecentTransactions,
          spamNftTransactionCount,
        } = buildEvmRecentTransactions(rawTransactions);

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

        if (spamNftTransactionCount > 0) {
          investigationWarnings.push(
            `${spamNftTransactionCount} likely spam/airdrop NFT transaction(s) were excluded from the activity sample used for transactionCountSample/activityLevel (still visible in the full recentTransactions list below, each flagged with likelySpam: true). This filter catches known patterns (Moralis's own spam flag, plus NFTs minted directly from the null address) - it does not catch all forms of NFT spam, such as mass-distribution campaigns disguised as legitimate marketplace activity.`,
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

        investigationWarnings.push(
          ...(nftHoldingsResult?.warnings ?? []).map(
            (warning) => warning.message,
          ),
        );

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
          recentTransactions: nonSpamRecentTransactions,
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
          transactionCountSample: nonSpamRecentTransactions.length,
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
          )} ETH. Recent transaction sample: ${nonSpamRecentTransactions.length}.`,
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

    case "bitcoin": {
      try {
        const connector = requireBlockchainConnector(chain);

        // Accepts either a single Bitcoin address or an xpub/ypub/zpub -
        // the connector handles which one internally (see chains/bitcoin.ts)
        // and every call below returns already-merged, multi-address-aware
        // data for xpub input, the same shape a single address would
        // produce. No xpub-vs-address branching needed here.
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

        const rawSatoshis = Number(nativeBalanceResult.data.rawAmount);
        const btcBalance = Number(
          nativeBalanceResult.data.decimalAmount ?? "0",
        );

        if (!Number.isFinite(rawSatoshis) || !Number.isFinite(btcBalance)) {
          throw new Error(
            "The Bitcoin connector returned an invalid balance.",
          );
        }

        // The full derived-address set - needed both for real transaction
        // parsing below (change-output detection: any output landing on
        // one of our OWN other addresses is definitively not an external
        // transfer, not a heuristic - see parsers/bitcoinTransaction.ts)
        // and for the multi-address funding/relationships/exposure match
        // (passed as addressSet to runWalletPipeline further down).
        const derivedAddresses =
          await bitcoinBlockchainConnector.deriveAddresses(walletAddress);
        const ownedAddresses = new Set(derivedAddresses);

        // Unlike Ethereum/Solana, calling connector.getTransactions()
        // directly here (rather than bypassing it for a raw provider call)
        // is deliberate, not an inconsistency: those chains bypass their
        // connector because Moralis/Helius return richer per-transaction
        // data than the connector's own createUniversalTransaction keeps -
        // going through the connector first would be a wasted round trip.
        // Bitcoin has no such richer data being discarded (blockchair.ts
        // doesn't decode transaction inputs/outputs either - see
        // chains/bitcoin.ts's capabilities), and going through the
        // connector here correctly reuses its xpub-vs-address merge logic
        // instead of duplicating it.
        //
        // TRANSACTION_LIST_LIMIT (coverage: recentTransactions,
        // transactionCountSample, activityLevel) is deliberately much
        // larger than TRANSACTIONS_TO_PARSE_LIMIT (coverage: funding/
        // relationships/exposure, via real inputs/outputs parsing) - see
        // the pagination design investigation. Blockchair's own
        // request_cost for the list itself is flat regardless of size
        // (live-confirmed at 100/1,000/10,000 alike), so listing more is
        // free; PARSING each one costs a batch call per 10 (see
        // getBitcoinTransactionsDetailed), so blindly parsing everything
        // listed would multiply cost ~10x for no benefit funding/
        // relationships/exposure would actually use - none of them
        // benefit from parsing beyond a bounded recent window the same
        // way activityLevel benefits from seeing the fuller list.
        const transactionsResult = await connector.getTransactions(
          walletAddress,
          { limit: TRANSACTION_LIST_LIMIT },
        );

        if (
          transactionsResult.status === "error" ||
          transactionsResult.status === "unsupported" ||
          !transactionsResult.data
        ) {
          throw new Error(
            transactionsResult.error?.message ??
              "Unable to retrieve the wallet transactions.",
          );
        }

        const recentTransactions: WalletRecentTransaction[] =
          transactionsResult.data.transactions.map((transaction) => ({
            transactionId: transaction.transactionId,
            blockHeight: transaction.blockHeight ?? undefined,
            blockTime: transaction.timestamp ?? undefined,
            status:
              transaction.status === "failed" ? "failed" : "success",
          }));

        const oldestTransactionResult =
          await connector.getOldestTransaction?.(walletAddress);

        if (
          !oldestTransactionResult ||
          oldestTransactionResult.status === "error" ||
          oldestTransactionResult.status === "unsupported" ||
          !oldestTransactionResult.data
        ) {
          throw new Error(
            oldestTransactionResult?.error?.message ??
              "Unable to retrieve the wallet's oldest transaction.",
          );
        }

        const oldestTransaction = oldestTransactionResult.data;

        // Real transaction parsing: batch-fetch full inputs/outputs (10
        // hashes per call, flat cost - see blockchair.ts's
        // getBitcoinTransactionsDetailed) for the most recent
        // TRANSACTIONS_TO_PARSE_LIMIT transactions in the (now much
        // larger) list, plus the oldest transaction if it isn't already
        // in that subset (deduped automatically - getBitcoinTransactionsDetailed
        // takes a plain array, not a special "extra" parameter). Bare
        // hash/timestamp-only records (chains/bitcoin.ts's
        // capabilities.transactionParsing: false) are gone - this is the
        // real thing now, for this bounded subset.
        const transactionsToParse = transactionsResult.data.transactions.slice(
          0,
          TRANSACTIONS_TO_PARSE_LIMIT,
        );

        const sampleTransactionHashes = transactionsToParse.map(
          (transaction) => transaction.transactionId,
        );

        const transactionDetailByHash = await getBitcoinTransactionsDetailed([
          ...sampleTransactionHashes,
          ...(oldestTransaction.transactionId
            ? [oldestTransaction.transactionId]
            : []),
        ]);

        // Transactions beyond TRANSACTIONS_TO_PARSE_LIMIT still show up in
        // recentTransactions/transactionCountSample/activityLevel above -
        // they're just not represented here with real transfer data, so
        // they can't contribute a funding/relationship/exposure match.
        // Disclosed via the transparency note below, not silently implied
        // to be fully covered.
        const normalizedRecentParsedTransactions: ParsedWalletTransaction[] =
          transactionsToParse.map((transaction) =>
            parseBitcoinTransaction(
              transactionDetailByHash[transaction.transactionId] ?? null,
              ownedAddresses,
            ),
          );

        const firstParsedTransaction = parseBitcoinTransaction(
          oldestTransaction.transactionId
            ? (transactionDetailByHash[oldestTransaction.transactionId] ??
                null)
            : null,
          ownedAddresses,
        );

        const tokenBalancesResult =
          await connector.getTokenBalances(walletAddress);

        const investigationWarnings: string[] =
          tokenBalancesResult.warnings.map((warning) => warning.message);

        investigationWarnings.push(
          ...oldestTransactionResult.warnings.map((warning) => warning.message),
        );

        const tokenHoldings: WalletTokenHolding[] =
          (tokenBalancesResult.data?.balances ?? []).map((tokenBalance) => ({
            tokenId: tokenBalance.asset.contractAddress ?? "",
            amount: 0,
            decimals: tokenBalance.asset.decimals ?? 0,
            rawAmount: tokenBalance.rawAmount,
          }));

        // NFT holdings: same tolerance as every other chain - Bitcoin's
        // connector doesn't implement getNftHoldings at all (no native NFT
        // standard - see chains/bitcoin.ts), so this degrades to an empty
        // list rather than a chain-name check.
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
          nativeAmount: btcBalance,
          nativeSymbol: "BTC",
          rawAmount: rawSatoshis,
        };

        const pipeline = await runWalletPipeline({
          chain,
          // The raw user input (a single address, or the xpub/ypub/zpub
          // string itself) - kept for display/evidence-record text.
          // Funding/relationships/exposure matching uses addressSet below
          // instead (the real derived-address set), not this string - an
          // xpub string would never match a real address in parsed
          // transfer data.
          address: walletAddress,
          addressSet: derivedAddresses,
          balance: walletBalance,
          tokenHoldings,
          recentTransactions,
          oldestTransactionId: oldestTransaction.transactionId ?? undefined,
          oldestTransactionTimestamp:
            oldestTransaction.timestamp ?? undefined,
          firstParsedTransaction,
          normalizedRecentParsedTransactions,
          tokenPrices,
        });

        const {
          activity,
          age,
          funding,
          portfolio,
          whale,
          defi,
          protocols,
          protocolIntelligence,
          behavior,
          relationships,
          exposure,
          custodyProfile,
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
          risk,
          complianceScreening,
        } = pipeline;

        const addressesInSample =
          derivedAddresses.length > 1 ? derivedAddresses.length : undefined;

        const activityWithAddressContext = addressesInSample
          ? { ...activity, addressesInSample }
          : activity;

        if (addressesInSample) {
          investigationWarnings.push(
            `This is an HD wallet with ${addressesInSample} derived address(es) found in the sample (via Blockchair's gap-limit address scan) - activityLevel reflects combined transaction volume across all of them, not one address, so it is not directly comparable to a single-address wallet's activityLevel at the same raw count.`,
          );
        }

        // Incoming transfers (who funded this wallet) are unambiguous
        // regardless of address count - an input's sender is always real,
        // no heuristic involved. Outgoing transfers (who this wallet paid,
        // used for counterparty/relationship exposure) are a different
        // story: Bitcoin has no field marking which output is "change"
        // back to the sender vs. a real second recipient. For an xpub
        // wallet this is fully resolved (any output landing on one of this
        // wallet's own other derived addresses is definitively excluded,
        // not a guess); for a single tracked address, an unfamiliar output
        // can't be told apart from unrecognized change - a known, unsolved
        // limitation of Bitcoin's UTXO model itself, not specific to this
        // tool.
        investigationWarnings.push(
          derivedAddresses.length > 1
            ? "Bitcoin (xpub): incoming-transfer funding detection is fully unambiguous. Outgoing-transfer/counterparty exposure is also reliable here, since any output landing on one of this wallet's own other derived addresses is correctly excluded as change, not treated as a real transfer. Multi-input transactions attribute the funding/counterparty amount to the single largest contributing address, not a full multi-party breakdown."
            : "Bitcoin (single address): incoming-transfer funding detection is unambiguous. Outgoing-transfer/counterparty exposure is not reliable for a single tracked address - an unfamiliar output address can't be distinguished from unrecognized change belonging to this same wallet, a known limitation of Bitcoin's UTXO model (not something a wallet-wide xpub view would have this problem with). Multi-input transactions attribute the funding amount to the single largest contributing address, not a full multi-party breakdown.",
        );

        investigationWarnings.push(
          "Address coverage for xpub/ypub/zpub input is whatever Blockchair's gap-limit scan found - addresses outside that scan window are not included.",
        );

        // The list (recentTransactions/transactionCountSample/
        // activityLevel) and the parsed subset (funding/relationships/
        // exposure) now cover meaningfully different windows - up to
        // TRANSACTION_LIST_LIMIT for the former, only the most recent
        // TRANSACTIONS_TO_PARSE_LIMIT of those (plus the oldest
        // transaction) for the latter. Only worth disclosing when the
        // list is actually bigger than what got parsed - a wallet with
        // fewer than TRANSACTIONS_TO_PARSE_LIMIT transactions total has
        // everything parsed already, nothing to caveat.
        if (recentTransactions.length > TRANSACTIONS_TO_PARSE_LIMIT) {
          investigationWarnings.push(
            `This wallet's activity/transaction-count coverage extends to ${recentTransactions.length} transactions, but funding/relationship/counterparty-exposure analysis is based on real transfer data parsed from only the most recent ${TRANSACTIONS_TO_PARSE_LIMIT} of those (plus the oldest transaction, parsed separately for age/funding) - a deliberate cost/coverage tradeoff, not a silent gap. A real counterparty or funding event further back than that window would not be reflected in relationships/exposure yet.`,
          );
        }

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
          activity: activityWithAddressContext,
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
          executiveVerdict,
          summary: `Wallet found. Current balance: ${btcBalance.toFixed(
            8,
          )} BTC. Recent transaction sample: ${recentTransactions.length}.`,
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
