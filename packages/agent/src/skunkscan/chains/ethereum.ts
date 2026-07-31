import {
  ChainAdapterCapabilities,
  UniversalAssetIdentifier,
  UniversalTransaction,
} from "../types";

import {
  EthereumNftHolding,
  EthereumTransaction,
  getEthereumBalance,
  getEthereumNftHoldings,
  getEthereumOldestTransaction,
  getEthereumTokenHoldings,
  getEthereumTransaction,
  getEthereumTransactions,
} from "../moralis";

import {
  AddressValidationResult,
  BlockchainConnector,
  BlockchainConnectorDescriptor,
  ChainConnectorHealth,
  ChainOperationResult,
  NativeBalanceResult,
  NftHoldingsResult,
  OldestTransactionResult,
  TokenBalancesResult,
  TransactionLookupResult,
  TransactionPageRequest,
  TransactionPageResult,
} from "./types";

const ETHEREUM_CHAIN_ID = "ethereum";
const WEI_PER_ETH = 1_000_000_000_000_000_000;

const ETHEREUM_NATIVE_ASSET: UniversalAssetIdentifier = {
  chainId: ETHEREUM_CHAIN_ID,
  assetType: "native",
  assetId: "ethereum:native:ETH",
  symbol: "ETH",
  name: "Ethereum",
  decimals: 18,
  contractAddress: null,
  tokenId: null,
};

// Partial support level, same spirit as Solana's descriptor: real balance/
// token/NFT/transaction-list retrieval, but transaction contents aren't
// decoded yet (transfers/programOrContractIds are empty) - that's PR 4.
const ETHEREUM_CAPABILITIES: ChainAdapterCapabilities = {
  addressValidation: true,
  balanceRetrieval: true,
  transactionRetrieval: true,
  transactionParsing: false,
  tokenRetrieval: true,
  nftRetrieval: true,
  protocolDetection: false,
  internalTransferDetection: false,
  historicalTransactionRetrieval: true,
};

function isValidEthereumAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address.trim());
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
      : "Unknown Ethereum connector error";

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

// No transaction contents have been decoded yet (PR 4's job) - this
// produces a real transaction record (id, block, timestamp, status) with
// empty transfers/programOrContractIds, the same "honest partial" shape
// Solana's own connector used before its transaction parsing existed.
function createUniversalTransaction(
  transaction: EthereumTransaction,
): UniversalTransaction {
  return {
    chainId: ETHEREUM_CHAIN_ID,
    transactionId: transaction.hash,
    blockIdentifier:
      transaction.blockNumber !== null
        ? String(transaction.blockNumber)
        : null,
    blockHeight: transaction.blockNumber,
    transactionIndex: null,
    timestamp: transaction.blockTimestamp,
    status:
      transaction.status === "success"
        ? "confirmed"
        : transaction.status === "failed"
          ? "failed"
          : "unknown",
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
      provider: "moralis",
      fromAddress: transaction.fromAddress,
      toAddress: transaction.toAddress,
      valueWei: transaction.valueWei,
    },
  };
}

function createEthereumNftAsset(
  nft: EthereumNftHolding,
): UniversalAssetIdentifier {
  return {
    chainId: ETHEREUM_CHAIN_ID,
    assetType: "nft",
    assetId: `ethereum:nft:${nft.contractAddress}:${nft.tokenId}`,
    decimals: null,
    contractAddress: nft.contractAddress,
    tokenId: nft.tokenId,
  };
}

export const ethereumConnectorDescriptor: BlockchainConnectorDescriptor = {
  chainId: ETHEREUM_CHAIN_ID,
  family: "evm",
  supportLevel: "partial",
  capabilities: ETHEREUM_CAPABILITIES,
  providerNames: ["Moralis"],
  limitations: [
    "Transaction contents (native/token transfers, contract interactions) are not yet decoded - transactions are listed but not parsed.",
    "Program/protocol classifications are not yet connected.",
    "Balance, token holdings, NFT holdings, and transaction-list shapes are live-spot-checked against Moralis (see moralis.ts's header comment); pagination cursor-threading on the transaction-history endpoint is not yet live-verified.",
    "For wallets holding an extremely large number of distinct tokens, Moralis's token-balances endpoint refuses the request outright regardless of pagination - the token list degrades to partial/empty with a warning rather than failing the whole wallet investigation.",
  ],
};

export class EthereumBlockchainConnector implements BlockchainConnector {
  readonly network = {
    id: ETHEREUM_CHAIN_ID,
    name: "Ethereum",
    family: "evm" as const,
    networkType: "mainnet" as const,
    addressModel: "account" as const,
    nativeAssetSymbol: "ETH",
    nativeAssetDecimals: 18,
    finalityType: "probabilistic" as const,
    capabilities: {
      supportsNativeAsset: true,
      supportsFungibleTokens: true,
      supportsNfts: true,
      supportsSmartContracts: true,
      supportsDefi: true,
      supportsStaking: true,
      supportsMemoOrTag: false,
      supportsInternalTransactions: true,
      supportsTransactionLogs: true,
      supportsTokenApprovals: true,
    },
    explorerUrl: "https://etherscan.io",
    chainReference: "ethereum-mainnet",
    isEnabled: true,
  };

  readonly descriptor = ethereumConnectorDescriptor;

  async validateAddress(
    address: string,
  ): Promise<ChainOperationResult<AddressValidationResult>> {
    const normalizedAddress = address.trim();
    const isValid = isValidEthereumAddress(normalizedAddress);

    return createSuccessResult({
      chainId: ETHEREUM_CHAIN_ID,
      address,
      normalizedAddress: normalizedAddress || null,
      isValid,
      addressType: "unknown",
      memoOrTagRequired: false,
      reason: isValid
        ? null
        : "Address does not match the expected Ethereum 0x-prefixed 40-hex-character format.",
    });
  }

  async getNativeBalance(
    address: string,
  ): Promise<ChainOperationResult<NativeBalanceResult>> {
    try {
      const balance = await getEthereumBalance(address);
      const wei = Number(balance.wei);

      return createSuccessResult({
        chainId: ETHEREUM_CHAIN_ID,
        address: balance.address,
        asset: ETHEREUM_NATIVE_ASSET,
        rawAmount: balance.wei,
        decimalAmount: Number.isFinite(wei)
          ? String(wei / WEI_PER_ETH)
          : null,
        estimatedUsdValue: null,
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(
        error,
        "ETHEREUM_BALANCE_RETRIEVAL_FAILED",
      );
    }
  }

  async getTokenBalances(
    address: string,
  ): Promise<ChainOperationResult<TokenBalancesResult>> {
    try {
      const { holdings, truncated } = await getEthereumTokenHoldings(address);

      return createSuccessResult(
        {
          chainId: ETHEREUM_CHAIN_ID,
          address: address.trim(),
          balances: holdings.map((holding) => ({
            asset: {
              chainId: ETHEREUM_CHAIN_ID,
              assetType: "fungible_token",
              assetId: `ethereum:token:${holding.contractAddress}`,
              symbol: holding.symbol,
              name: holding.name,
              decimals: holding.decimals,
              contractAddress: holding.contractAddress,
              tokenId: null,
            },
            rawAmount: holding.rawAmount,
            decimalAmount: null,
            estimatedUsdValue: null,
          })),
          retrievedAt: new Date().toISOString(),
        },
        truncated
          ? [
              {
                code: "ETHEREUM_TOKEN_BALANCE_COUNT_EXCEEDS_PROVIDER_LIMIT",
                message:
                  "This wallet holds more distinct tokens than Moralis's token-balances endpoint can enumerate - the token list below is incomplete, not an accurate 'this wallet holds no/few tokens' result.",
              },
            ]
          : [],
      );
    } catch (error) {
      return createErrorResult(
        error,
        "ETHEREUM_TOKEN_BALANCE_RETRIEVAL_FAILED",
      );
    }
  }

  async getNftHoldings(
    address: string,
  ): Promise<ChainOperationResult<NftHoldingsResult>> {
    try {
      const holdings = await getEthereumNftHoldings(address);

      return createSuccessResult({
        chainId: ETHEREUM_CHAIN_ID,
        address: address.trim(),
        holdings: holdings.map((nft) => ({
          asset: createEthereumNftAsset(nft),
          name: nft.name,
          collection: null,
          imageUrl: nft.imageUrl,
        })),
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(
        error,
        "ETHEREUM_NFT_RETRIEVAL_FAILED",
      );
    }
  }

  async getTransactions(
    address: string,
    request: TransactionPageRequest = {},
  ): Promise<ChainOperationResult<TransactionPageResult>> {
    try {
      const requestedLimit =
        typeof request.limit === "number" ? request.limit : 20;

      const limit = Math.max(1, Math.min(100, requestedLimit));

      const { transactions: rawTransactions, nextCursor } =
        await getEthereumTransactions(address, limit, request.cursor);

      const transactions = rawTransactions.map(createUniversalTransaction);

      return createSuccessResult(
        {
          chainId: ETHEREUM_CHAIN_ID,
          address: address.trim(),
          transactions,
          nextCursor,
          hasMore: nextCursor !== null,
          retrievedAt: new Date().toISOString(),
        },
        [
          {
            code: "ETHEREUM_TRANSACTION_COVERAGE_PARTIAL",
            message:
              "Transactions are listed but not yet parsed - transfers and program/contract IDs are not yet populated.",
          },
        ],
      );
    } catch (error) {
      return createErrorResult(
        error,
        "ETHEREUM_TRANSACTION_RETRIEVAL_FAILED",
      );
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
            code: "ETHEREUM_TRANSACTION_ID_REQUIRED",
            message: "Transaction ID is required.",
            retryable: false,
          },
        };
      }

      const rawTransaction = await getEthereumTransaction(
        cleanedTransactionId,
      );

      const transaction = rawTransaction
        ? createUniversalTransaction(rawTransaction)
        : null;

      return createSuccessResult(
        {
          chainId: ETHEREUM_CHAIN_ID,
          transactionId: cleanedTransactionId,
          transaction,
          retrievedAt: new Date().toISOString(),
        },
        transaction
          ? [
              {
                code: "ETHEREUM_TRANSACTION_COVERAGE_PARTIAL",
                message:
                  "The transaction was found but not yet parsed for transfers or contract interactions.",
              },
            ]
          : [
              {
                code: "ETHEREUM_TRANSACTION_NOT_FOUND",
                message: "No transaction data was returned for this transaction ID.",
              },
            ],
      );
    } catch (error) {
      return createErrorResult(
        error,
        "ETHEREUM_TRANSACTION_LOOKUP_FAILED",
      );
    }
  }

  async getOldestTransaction(
    address: string,
  ): Promise<ChainOperationResult<OldestTransactionResult>> {
    try {
      // Moralis's wallet-history endpoint accepts order=ASC, which
      // returns the oldest transaction directly in a single call -
      // live-verified against a wallet with 10 years of history. An
      // earlier version of this method walked pages forward via cursor
      // with a capped scan window and returned the last transaction it
      // happened to see, which silently mislabeled a transaction from
      // deep in the capped window as "oldest" for any wallet with more
      // history than the cap covered - confirmed broken before this fix.
      const oldestTransaction = await getEthereumOldestTransaction(address);

      if (!oldestTransaction) {
        return createSuccessResult({
          chainId: ETHEREUM_CHAIN_ID,
          address: address.trim(),
          transactionId: null,
          transaction: null,
          timestamp: null,
          retrievedAt: new Date().toISOString(),
        });
      }

      return createSuccessResult({
        chainId: ETHEREUM_CHAIN_ID,
        address: address.trim(),
        transactionId: oldestTransaction.hash,
        transaction: createUniversalTransaction(oldestTransaction),
        timestamp: oldestTransaction.blockTimestamp,
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(
        error,
        "ETHEREUM_OLDEST_TRANSACTION_FAILED",
      );
    }
  }

  async getHealth(): Promise<ChainConnectorHealth> {
    const apiKeyAvailable = Boolean(process.env.MORALIS_API_KEY?.trim());

    return {
      chainId: ETHEREUM_CHAIN_ID,
      status: apiKeyAvailable ? "healthy" : "unavailable",
      checkedAt: new Date().toISOString(),
      providerNames: ["Moralis"],
      notes: apiKeyAvailable
        ? [
            "Moralis API key is configured.",
            "No network request was performed during this health check.",
          ]
        : ["MORALIS_API_KEY is not configured."],
    };
  }
}

export const ethereumBlockchainConnector = new EthereumBlockchainConnector();
