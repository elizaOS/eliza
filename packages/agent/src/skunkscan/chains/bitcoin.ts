// Bitcoin connector. PR 2 of the Bitcoin rollout (see the xpub design
// investigation + approved implementation plan) - implements the standard
// BlockchainConnector interface using blockchair.ts (PR 1), with the
// xpub-vs-single-address branching entirely internal to this file's
// methods so callers see the exact same interface every other chain does.
// Still fully inert: not registered in chains/registry.ts, and nothing in
// investigateWallet references "bitcoin" yet - that's PR 3.
import {
  ChainAdapterCapabilities,
  UniversalAssetIdentifier,
  UniversalTransaction,
} from "../types";

import {
  BlockchairTransactionSummary,
  getBitcoinAddressDashboard,
  getBitcoinTransaction,
  getBitcoinXpubDashboard,
  isBitcoinAddress,
  isBitcoinXpub,
} from "../blockchair";

import {
  AddressValidationResult,
  BlockchainConnector,
  BlockchainConnectorDescriptor,
  ChainConnectorHealth,
  ChainOperationResult,
  NativeBalanceResult,
  OldestTransactionResult,
  TokenBalancesResult,
  TransactionLookupResult,
  TransactionPageRequest,
  TransactionPageResult,
} from "./types";

const BITCOIN_CHAIN_ID = "bitcoin";
const SATOSHIS_PER_BTC = 100_000_000;

const BITCOIN_NATIVE_ASSET: UniversalAssetIdentifier = {
  chainId: BITCOIN_CHAIN_ID,
  assetType: "native",
  assetId: "bitcoin:native:BTC",
  symbol: "BTC",
  name: "Bitcoin",
  decimals: 8,
  contractAddress: null,
  tokenId: null,
};

// transactionParsing/protocolDetection false: transactions are listed
// (hash/block/timestamp/net balance change) but inputs/outputs are not
// decoded into real transfers yet - the same "listed, not parsed" state
// chains/ethereum.ts shipped with initially. tokenRetrieval/nftRetrieval
// false: Bitcoin has no native fungible-token or NFT standard (Ordinals/
// BRC-20 exist as a separate ecosystem layered on top and are explicitly
// out of scope for this MVP, per the chain-expansion design investigation).
const BITCOIN_CAPABILITIES: ChainAdapterCapabilities = {
  addressValidation: true,
  balanceRetrieval: true,
  transactionRetrieval: true,
  transactionParsing: false,
  tokenRetrieval: false,
  nftRetrieval: false,
  protocolDetection: false,
  internalTransferDetection: false,
  historicalTransactionRetrieval: true,
};

// Format-shape validation only (same spirit as ethereum.ts's regex check -
// not full base58check/bech32 checksum validation, no new dependency for
// that). Legacy (1...) and P2SH (3...) are base58; native SegWit (bc1...)
// is bech32; xpub/ypub/zpub are base58-encoded extended keys, always ~111
// chars for a standard depth-3 account-level key.
const BITCOIN_LEGACY_OR_P2SH_PATTERN = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const BITCOIN_BECH32_PATTERN = /^bc1[ac-hj-np-z02-9]{11,71}$/;
const BITCOIN_XPUB_PATTERN = /^[xyz]pub[a-km-zA-HJ-NP-Z1-9]{100,112}$/;

function isValidBitcoinAddressOrXpub(input: string): boolean {
  const trimmed = input.trim();

  return (
    BITCOIN_LEGACY_OR_P2SH_PATTERN.test(trimmed) ||
    BITCOIN_BECH32_PATTERN.test(trimmed) ||
    BITCOIN_XPUB_PATTERN.test(trimmed)
  );
}

function createSuccessResult<T>(
  data: T,
  warnings: ChainOperationResult<T>["warnings"] = [],
): ChainOperationResult<T> {
  return {
    status: warnings.length > 0 ? "partial" : "success",
    data,
    warnings,
  };
}

function createErrorResult<T>(
  error: unknown,
  code: string,
): ChainOperationResult<T> {
  const message =
    error instanceof Error
      ? error.message
      : "Unknown Bitcoin connector error";

  return {
    status: "error",
    warnings: [],
    error: {
      code,
      message,
      retryable: true,
    },
  };
}

// Blockchair's "time" field is "YYYY-MM-DD HH:MM:SS" UTC (see blockchair.ts)
// - not epoch seconds. Returns null rather than throwing on an unexpected
// shape, since a bad timestamp shouldn't fail the whole transaction record.
function parseBlockchairTimestamp(time: string | undefined): number | null {
  if (!time) {
    return null;
  }

  const parsedMs = Date.parse(`${time.replace(" ", "T")}Z`);

  return Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : null;
}

function createUniversalTransaction(
  transaction: BlockchairTransactionSummary,
): UniversalTransaction {
  return {
    chainId: BITCOIN_CHAIN_ID,
    transactionId: transaction.hash,
    blockIdentifier:
      typeof transaction.block_id === "number"
        ? String(transaction.block_id)
        : null,
    blockHeight:
      typeof transaction.block_id === "number" ? transaction.block_id : null,
    transactionIndex: null,
    timestamp: parseBlockchairTimestamp(transaction.time),
    // Blockchair's dashboard endpoints only return confirmed, on-chain
    // transactions - there is no "failed but included" concept in Bitcoin
    // the way an EVM contract call can revert, so "confirmed" is correct
    // for every transaction this connector can return.
    status: "confirmed",
    classifications: ["unknown"],
    initiator: null,
    signers: [],
    counterparties: [],
    transfers: [],
    fee: null,
    programOrContractIds: [],
    memo: null,
    rawDataAvailable: false,
    metadata: {
      provider: "blockchair",
      balanceChangeSatoshis: transaction.balance_change ?? null,
      derivedAddress: transaction.address ?? null,
    },
  };
}

export const bitcoinConnectorDescriptor: BlockchainConnectorDescriptor = {
  chainId: BITCOIN_CHAIN_ID,
  family: "utxo",
  supportLevel: "partial",
  capabilities: BITCOIN_CAPABILITIES,
  providerNames: ["Blockchair"],
  limitations: [
    "Transaction contents are not yet decoded - transactions are listed (hash, block, timestamp, net balance change) but inputs/outputs are not parsed into real transfers.",
    "Pagination is not yet implemented - getTransactions returns only the most recent transactions up to the requested limit, with hasMore always false.",
    "Bitcoin has no native fungible-token or NFT standard - getTokenBalances always returns an empty list, and getNftHoldings is not implemented. Ordinals/BRC-20 are a separate ecosystem and are out of scope.",
    "Address validation is format-shape only (base58/bech32 prefix and length), not full checksum validation.",
  ],
};

export class BitcoinBlockchainConnector implements BlockchainConnector {
  readonly network = {
    id: BITCOIN_CHAIN_ID,
    name: "Bitcoin",
    family: "utxo" as const,
    networkType: "mainnet" as const,
    addressModel: "utxo" as const,
    nativeAssetSymbol: "BTC",
    nativeAssetDecimals: 8,
    finalityType: "probabilistic" as const,
    capabilities: {
      supportsNativeAsset: true,
      supportsFungibleTokens: false,
      supportsNfts: false,
      supportsSmartContracts: false,
      supportsDefi: false,
      supportsStaking: false,
      supportsMemoOrTag: false,
      supportsInternalTransactions: false,
      supportsTransactionLogs: false,
      supportsTokenApprovals: false,
    },
    explorerUrl: "https://mempool.space",
    chainReference: "bitcoin-mainnet",
    isEnabled: true,
  };

  readonly descriptor = bitcoinConnectorDescriptor;

  async validateAddress(
    address: string,
  ): Promise<ChainOperationResult<AddressValidationResult>> {
    const normalizedAddress = address.trim();
    const isValid = isValidBitcoinAddressOrXpub(normalizedAddress);

    return createSuccessResult({
      chainId: BITCOIN_CHAIN_ID,
      address,
      normalizedAddress: normalizedAddress || null,
      isValid,
      addressType: "unknown",
      memoOrTagRequired: false,
      reason: isValid
        ? null
        : "Input does not match a recognized Bitcoin address (legacy, P2SH, native SegWit) or extended public key (xpub/ypub/zpub) format.",
    });
  }

  async getNativeBalance(
    address: string,
  ): Promise<ChainOperationResult<NativeBalanceResult>> {
    try {
      const trimmedAddress = address.trim();

      const balanceSatoshis = isBitcoinXpub(trimmedAddress)
        ? (await getBitcoinXpubDashboard(trimmedAddress)).xpub.balance
        : (await getBitcoinAddressDashboard(trimmedAddress)).address.balance;

      const rawSatoshis = typeof balanceSatoshis === "number" ? balanceSatoshis : 0;

      return createSuccessResult({
        chainId: BITCOIN_CHAIN_ID,
        address: trimmedAddress,
        asset: BITCOIN_NATIVE_ASSET,
        rawAmount: String(rawSatoshis),
        decimalAmount: String(rawSatoshis / SATOSHIS_PER_BTC),
        estimatedUsdValue: null,
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(error, "BITCOIN_BALANCE_RETRIEVAL_FAILED");
    }
  }

  async getTokenBalances(
    address: string,
  ): Promise<ChainOperationResult<TokenBalancesResult>> {
    return createSuccessResult(
      {
        chainId: BITCOIN_CHAIN_ID,
        address: address.trim(),
        balances: [],
        retrievedAt: new Date().toISOString(),
      },
      [
        {
          code: "BITCOIN_NO_NATIVE_TOKEN_STANDARD",
          message:
            "Bitcoin has no native fungible-token standard - this list is always empty, not an indication the wallet holds nothing else of value. Ordinals/BRC-20 are a separate ecosystem and are not covered.",
        },
      ],
    );
  }

  async getTransactions(
    address: string,
    request: TransactionPageRequest = {},
  ): Promise<ChainOperationResult<TransactionPageResult>> {
    try {
      const trimmedAddress = address.trim();
      const requestedLimit =
        typeof request.limit === "number" ? request.limit : 20;
      const limit = Math.max(1, Math.min(100, requestedLimit));

      const rawTransactions = isBitcoinXpub(trimmedAddress)
        ? (await getBitcoinXpubDashboard(trimmedAddress)).transactions
        : (await getBitcoinAddressDashboard(trimmedAddress)).transactions;

      const transactions = rawTransactions
        .slice(0, limit)
        .map(createUniversalTransaction);

      return createSuccessResult(
        {
          chainId: BITCOIN_CHAIN_ID,
          address: trimmedAddress,
          transactions,
          nextCursor: null,
          hasMore: false,
          retrievedAt: new Date().toISOString(),
        },
        [
          {
            code: "BITCOIN_TRANSACTION_COVERAGE_PARTIAL",
            message:
              "Transactions are listed but not yet parsed - transfers are not populated. Pagination is not yet implemented; only the most recent transactions up to the requested limit are returned.",
          },
        ],
      );
    } catch (error) {
      return createErrorResult(error, "BITCOIN_TRANSACTION_RETRIEVAL_FAILED");
    }
  }

  async getTransaction(
    transactionId: string,
  ): Promise<ChainOperationResult<TransactionLookupResult>> {
    try {
      const cleanedTransactionId = transactionId.trim();

      if (!cleanedTransactionId) {
        return {
          status: "error",
          warnings: [],
          error: {
            code: "BITCOIN_TRANSACTION_ID_REQUIRED",
            message: "Transaction ID is required.",
            retryable: false,
          },
        };
      }

      const rawTransaction = await getBitcoinTransaction(cleanedTransactionId);

      const transaction = rawTransaction
        ? createUniversalTransaction(rawTransaction)
        : null;

      return createSuccessResult(
        {
          chainId: BITCOIN_CHAIN_ID,
          transactionId: cleanedTransactionId,
          transaction,
          retrievedAt: new Date().toISOString(),
        },
        transaction
          ? [
              {
                code: "BITCOIN_TRANSACTION_COVERAGE_PARTIAL",
                message:
                  "The transaction was found but not yet parsed into transfers.",
              },
            ]
          : [
              {
                code: "BITCOIN_TRANSACTION_NOT_FOUND",
                message: "No transaction data was returned for this transaction ID.",
              },
            ],
      );
    } catch (error) {
      return createErrorResult(error, "BITCOIN_TRANSACTION_LOOKUP_FAILED");
    }
  }

  async getOldestTransaction(
    address: string,
  ): Promise<ChainOperationResult<OldestTransactionResult>> {
    try {
      const trimmedAddress = address.trim();

      // Blockchair's dashboards return the most recent transactions first,
      // with no server-side "give me the oldest" option (unlike Moralis's
      // order=ASC for EVM) - the oldest transaction within the returned
      // page is the closest available approximation, not the wallet's
      // true first-ever transaction if it has more history than one page
      // covers. Disclosed via the warning below, not silently assumed.
      const rawTransactions = isBitcoinXpub(trimmedAddress)
        ? (await getBitcoinXpubDashboard(trimmedAddress)).transactions
        : (await getBitcoinAddressDashboard(trimmedAddress)).transactions;

      if (rawTransactions.length === 0) {
        return createSuccessResult({
          chainId: BITCOIN_CHAIN_ID,
          address: trimmedAddress,
          transactionId: null,
          transaction: null,
          timestamp: null,
          retrievedAt: new Date().toISOString(),
        });
      }

      const oldestInPage = rawTransactions[rawTransactions.length - 1];
      const transaction = createUniversalTransaction(oldestInPage);

      return createSuccessResult(
        {
          chainId: BITCOIN_CHAIN_ID,
          address: trimmedAddress,
          transactionId: oldestInPage.hash,
          transaction,
          timestamp: transaction.timestamp ?? null,
          retrievedAt: new Date().toISOString(),
        },
        [
          {
            code: "BITCOIN_OLDEST_TRANSACTION_APPROXIMATE",
            message:
              "This is the oldest transaction within the most recent page of results, not necessarily the wallet's true first-ever transaction - full-history pagination is not yet implemented for Bitcoin.",
          },
        ],
      );
    } catch (error) {
      return createErrorResult(error, "BITCOIN_OLDEST_TRANSACTION_FAILED");
    }
  }

  async getHealth(): Promise<ChainConnectorHealth> {
    const apiKeyAvailable = Boolean(process.env.BLOCKCHAIR_API_KEY?.trim());

    return {
      chainId: BITCOIN_CHAIN_ID,
      status: apiKeyAvailable ? "healthy" : "unavailable",
      checkedAt: new Date().toISOString(),
      providerNames: ["Blockchair"],
      notes: apiKeyAvailable
        ? [
            "Blockchair API key is configured.",
            "No network request was performed during this health check.",
          ]
        : ["BLOCKCHAIR_API_KEY is not configured."],
    };
  }

  // Not part of the shared BlockchainConnector interface (see chains/types.ts)
  // - an optional, Bitcoin-specific capability. Returns the full set of
  // addresses a caller needs for cross-address work (like the exposure-
  // registry merge from the approved multi-address scoring design) that
  // this connector's own standard methods don't expose, since they only
  // return already-aggregated data. For a single address, returns that one
  // address unchanged so callers don't need to branch on input type
  // themselves.
  async deriveAddresses(input: string): Promise<string[]> {
    const trimmedInput = input.trim();

    if (isBitcoinXpub(trimmedInput)) {
      const dashboard = await getBitcoinXpubDashboard(trimmedInput);
      return Object.keys(dashboard.addresses);
    }

    return [trimmedInput];
  }
}

export const bitcoinBlockchainConnector = new BitcoinBlockchainConnector();
