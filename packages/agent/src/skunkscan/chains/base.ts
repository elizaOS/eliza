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

// "base" happens to be both this codebase's internal chain identifier
// (SupportedChain) AND Moralis's own chain-parameter value - confirmed
// against Moralis's chain-parameter enum, not assumed just because the
// strings match (BSC's "bnb"/"bsc" mismatch is exactly why this needed
// checking rather than assuming). Base is Coinbase's L2 and uses ETH as
// its gas/native asset - it is NOT a separate token the way BNB is on BSC,
// confirmed rather than assumed (Base's L2 model settles to Ethereum and
// uses ETH for gas throughout).
const BASE_CHAIN_ID = "base";
const MORALIS_CHAIN = "base" as const;
const WEI_PER_ETH = 1_000_000_000_000_000_000;

const BASE_NATIVE_ASSET: UniversalAssetIdentifier = {
  chainId: BASE_CHAIN_ID,
  assetType: "native",
  assetId: "base:native:ETH",
  symbol: "ETH",
  name: "Ethereum",
  decimals: 18,
  contractAddress: null,
  tokenId: null,
};

// Same partial-support shape as the Ethereum/BNB connectors, for the same
// reason: real balance/token/NFT/transaction-list retrieval, but
// transaction contents aren't decoded on THIS connector's own
// getTransactions/getTransaction/getOldestTransaction path
// (createUniversalTransaction below still hardcodes empty transfers/
// programOrContractIds). investigateWallet's "base" branch in wallet.ts
// gets real parsing + protocol detection via parsers/ethereumTransaction.ts
// (genuinely EVM-generic, reused as-is) + the protocols/base registry,
// bypassing this connector's createUniversalTransaction entirely - same
// arrangement as Ethereum/BNB.
const BASE_CAPABILITIES: ChainAdapterCapabilities = {
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

function isValidBaseAddress(address: string): boolean {
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
      : "Unknown Base connector error";

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

function createUniversalTransaction(
  transaction: EthereumTransaction,
): UniversalTransaction {
  return {
    chainId: BASE_CHAIN_ID,
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

function createBaseNftAsset(
  nft: EthereumNftHolding,
): UniversalAssetIdentifier {
  return {
    chainId: BASE_CHAIN_ID,
    assetType: "nft",
    assetId: `base:nft:${nft.contractAddress}:${nft.tokenId}`,
    decimals: null,
    contractAddress: nft.contractAddress,
    tokenId: nft.tokenId,
  };
}

export const baseConnectorDescriptor: BlockchainConnectorDescriptor = {
  chainId: BASE_CHAIN_ID,
  family: "evm",
  supportLevel: "partial",
  capabilities: BASE_CAPABILITIES,
  providerNames: ["Moralis"],
  limitations: [
    "Transaction contents (native/token transfers, contract interactions) are not yet decoded - transactions are listed but not parsed.",
    "Program/protocol classifications are not yet connected.",
    "Balance, token holdings, NFT holdings, and transaction-list shapes reuse the same Moralis wallet-history endpoint already live-verified for Ethereum/BSC, with chain=base instead of chain=eth/bsc - same response shape, per Moralis's docs.",
    "For wallets holding an extremely large number of distinct tokens, Moralis's token-balances endpoint refuses the request outright regardless of pagination - the token list degrades to partial/empty with a warning rather than failing the whole wallet investigation.",
  ],
};

export class BaseBlockchainConnector implements BlockchainConnector {
  readonly network = {
    id: BASE_CHAIN_ID,
    name: "Base",
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
    explorerUrl: "https://basescan.org",
    chainReference: "base-mainnet",
    isEnabled: true,
  };

  readonly descriptor = baseConnectorDescriptor;

  async validateAddress(
    address: string,
  ): Promise<ChainOperationResult<AddressValidationResult>> {
    const normalizedAddress = address.trim();
    const isValid = isValidBaseAddress(normalizedAddress);

    return createSuccessResult({
      chainId: BASE_CHAIN_ID,
      address,
      normalizedAddress: normalizedAddress || null,
      isValid,
      addressType: "unknown",
      memoOrTagRequired: false,
      reason: isValid
        ? null
        : "Address does not match the expected Base 0x-prefixed 40-hex-character format.",
    });
  }

  async getNativeBalance(
    address: string,
  ): Promise<ChainOperationResult<NativeBalanceResult>> {
    try {
      const balance = await getEthereumBalance(address, MORALIS_CHAIN);
      const wei = Number(balance.wei);

      return createSuccessResult({
        chainId: BASE_CHAIN_ID,
        address: balance.address,
        asset: BASE_NATIVE_ASSET,
        rawAmount: balance.wei,
        decimalAmount: Number.isFinite(wei)
          ? String(wei / WEI_PER_ETH)
          : null,
        estimatedUsdValue: null,
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(error, "BASE_BALANCE_RETRIEVAL_FAILED");
    }
  }

  async getTokenBalances(
    address: string,
  ): Promise<ChainOperationResult<TokenBalancesResult>> {
    try {
      const { holdings, truncated } = await getEthereumTokenHoldings(
        address,
        MORALIS_CHAIN,
      );

      return createSuccessResult(
        {
          chainId: BASE_CHAIN_ID,
          address: address.trim(),
          balances: holdings.map((holding) => ({
            asset: {
              chainId: BASE_CHAIN_ID,
              assetType: "fungible_token",
              assetId: `base:token:${holding.contractAddress}`,
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
                code: "BASE_TOKEN_BALANCE_COUNT_EXCEEDS_PROVIDER_LIMIT",
                message:
                  "This wallet holds more distinct tokens than Moralis's token-balances endpoint can enumerate - the token list below is incomplete, not an accurate 'this wallet holds no/few tokens' result.",
              },
            ]
          : [],
      );
    } catch (error) {
      return createErrorResult(error, "BASE_TOKEN_BALANCE_RETRIEVAL_FAILED");
    }
  }

  async getNftHoldings(
    address: string,
  ): Promise<ChainOperationResult<NftHoldingsResult>> {
    try {
      const { holdings, truncated } = await getEthereumNftHoldings(
        address,
        MORALIS_CHAIN,
      );

      return createSuccessResult(
        {
          chainId: BASE_CHAIN_ID,
          address: address.trim(),
          holdings: holdings.map((nft) => ({
            asset: createBaseNftAsset(nft),
            name: nft.name,
            collection: null,
            imageUrl: nft.imageUrl,
          })),
          retrievedAt: new Date().toISOString(),
        },
        truncated
          ? [
              {
                code: "BASE_NFT_COUNT_EXCEEDS_PAGE_LIMIT",
                message:
                  "This wallet holds more NFTs than could be retrieved within the page limit - the list below is incomplete, not an accurate 'this wallet holds few/no NFTs' result.",
              },
            ]
          : [],
      );
    } catch (error) {
      return createErrorResult(error, "BASE_NFT_RETRIEVAL_FAILED");
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
        await getEthereumTransactions(
          address,
          MORALIS_CHAIN,
          limit,
          request.cursor,
        );

      const transactions = rawTransactions.map(createUniversalTransaction);

      return createSuccessResult(
        {
          chainId: BASE_CHAIN_ID,
          address: address.trim(),
          transactions,
          nextCursor,
          hasMore: nextCursor !== null,
          retrievedAt: new Date().toISOString(),
        },
        [
          {
            code: "BASE_TRANSACTION_COVERAGE_PARTIAL",
            message:
              "Transactions are listed but not yet parsed - transfers and program/contract IDs are not yet populated.",
          },
        ],
      );
    } catch (error) {
      return createErrorResult(error, "BASE_TRANSACTION_RETRIEVAL_FAILED");
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
            code: "BASE_TRANSACTION_ID_REQUIRED",
            message: "Transaction ID is required.",
            retryable: false,
          },
        };
      }

      const rawTransaction = await getEthereumTransaction(
        cleanedTransactionId,
        MORALIS_CHAIN,
      );

      const transaction = rawTransaction
        ? createUniversalTransaction(rawTransaction)
        : null;

      return createSuccessResult(
        {
          chainId: BASE_CHAIN_ID,
          transactionId: cleanedTransactionId,
          transaction,
          retrievedAt: new Date().toISOString(),
        },
        transaction
          ? [
              {
                code: "BASE_TRANSACTION_COVERAGE_PARTIAL",
                message:
                  "The transaction was found but not yet parsed for transfers or contract interactions.",
              },
            ]
          : [
              {
                code: "BASE_TRANSACTION_NOT_FOUND",
                message: "No transaction data was returned for this transaction ID.",
              },
            ],
      );
    } catch (error) {
      return createErrorResult(error, "BASE_TRANSACTION_LOOKUP_FAILED");
    }
  }

  async getOldestTransaction(
    address: string,
  ): Promise<ChainOperationResult<OldestTransactionResult>> {
    try {
      // Same order=ASC&limit=1 single-call approach already live-verified
      // for Ethereum/BSC - Moralis's wallet-history endpoint supports it
      // identically for chain=base.
      const oldestTransaction = await getEthereumOldestTransaction(
        address,
        MORALIS_CHAIN,
      );

      if (!oldestTransaction) {
        return createSuccessResult({
          chainId: BASE_CHAIN_ID,
          address: address.trim(),
          transactionId: null,
          transaction: null,
          timestamp: null,
          retrievedAt: new Date().toISOString(),
        });
      }

      return createSuccessResult({
        chainId: BASE_CHAIN_ID,
        address: address.trim(),
        transactionId: oldestTransaction.hash,
        transaction: createUniversalTransaction(oldestTransaction),
        timestamp: oldestTransaction.blockTimestamp,
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(error, "BASE_OLDEST_TRANSACTION_FAILED");
    }
  }

  async getHealth(): Promise<ChainConnectorHealth> {
    const apiKeyAvailable = Boolean(process.env.MORALIS_API_KEY?.trim());

    return {
      chainId: BASE_CHAIN_ID,
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

export const baseBlockchainConnector = new BaseBlockchainConnector();
