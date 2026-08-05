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

// "bnb" is this codebase's internal chain identifier (SupportedChain), NOT
// the same string Moralis expects on the wire - Moralis's own chain param
// for BSC is "bsc" (confirmed live and against Moralis's docs). Every
// moralis.ts call below passes "bsc" explicitly; do not conflate the two.
const BNB_CHAIN_ID = "bnb";
const MORALIS_CHAIN = "bsc" as const;
const WEI_PER_BNB = 1_000_000_000_000_000_000;

const BNB_NATIVE_ASSET: UniversalAssetIdentifier = {
  chainId: BNB_CHAIN_ID,
  assetType: "native",
  assetId: "bnb:native:BNB",
  symbol: "BNB",
  name: "BNB",
  decimals: 18,
  contractAddress: null,
  tokenId: null,
};

// Same partial-support shape as the Ethereum connector, for the same
// reason: real balance/token/NFT/transaction-list retrieval, but
// transaction contents aren't decoded on THIS connector's own
// getTransactions/getTransaction/getOldestTransaction path
// (createUniversalTransaction below still hardcodes empty transfers/
// programOrContractIds). investigateWallet's "bnb" branch in wallet.ts
// gets real parsing + protocol detection via parsers/ethereumTransaction.ts
// (genuinely EVM-generic, reused as-is) + the protocols/bnb registry,
// bypassing this connector's createUniversalTransaction entirely - same
// arrangement as Ethereum.
const BNB_CAPABILITIES: ChainAdapterCapabilities = {
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

function isValidBnbAddress(address: string): boolean {
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
      : "Unknown BNB Smart Chain connector error";

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
    chainId: BNB_CHAIN_ID,
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

function createBnbNftAsset(
  nft: EthereumNftHolding,
): UniversalAssetIdentifier {
  return {
    chainId: BNB_CHAIN_ID,
    assetType: "nft",
    assetId: `bnb:nft:${nft.contractAddress}:${nft.tokenId}`,
    decimals: null,
    contractAddress: nft.contractAddress,
    tokenId: nft.tokenId,
  };
}

export const bnbConnectorDescriptor: BlockchainConnectorDescriptor = {
  chainId: BNB_CHAIN_ID,
  family: "evm",
  supportLevel: "partial",
  capabilities: BNB_CAPABILITIES,
  providerNames: ["Moralis"],
  limitations: [
    "Transaction contents (native/token transfers, contract interactions) are not yet decoded - transactions are listed but not parsed.",
    "Program/protocol classifications are not yet connected.",
    "Balance, token holdings, NFT holdings, and transaction-list shapes reuse the same Moralis wallet-history endpoint already live-verified for Ethereum, with chain=bsc instead of chain=eth - same response shape, per Moralis's docs.",
    "For wallets holding an extremely large number of distinct tokens, Moralis's token-balances endpoint refuses the request outright regardless of pagination - the token list degrades to partial/empty with a warning rather than failing the whole wallet investigation.",
  ],
};

export class BnbBlockchainConnector implements BlockchainConnector {
  readonly network = {
    id: BNB_CHAIN_ID,
    name: "BNB Smart Chain",
    family: "evm" as const,
    networkType: "mainnet" as const,
    addressModel: "account" as const,
    nativeAssetSymbol: "BNB",
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
    explorerUrl: "https://bscscan.com",
    chainReference: "bnb-mainnet",
    isEnabled: true,
  };

  readonly descriptor = bnbConnectorDescriptor;

  async validateAddress(
    address: string,
  ): Promise<ChainOperationResult<AddressValidationResult>> {
    const normalizedAddress = address.trim();
    const isValid = isValidBnbAddress(normalizedAddress);

    return createSuccessResult({
      chainId: BNB_CHAIN_ID,
      address,
      normalizedAddress: normalizedAddress || null,
      isValid,
      addressType: "unknown",
      memoOrTagRequired: false,
      reason: isValid
        ? null
        : "Address does not match the expected BNB Smart Chain 0x-prefixed 40-hex-character format.",
    });
  }

  async getNativeBalance(
    address: string,
  ): Promise<ChainOperationResult<NativeBalanceResult>> {
    try {
      const balance = await getEthereumBalance(address, MORALIS_CHAIN);
      const wei = Number(balance.wei);

      return createSuccessResult({
        chainId: BNB_CHAIN_ID,
        address: balance.address,
        asset: BNB_NATIVE_ASSET,
        rawAmount: balance.wei,
        decimalAmount: Number.isFinite(wei)
          ? String(wei / WEI_PER_BNB)
          : null,
        estimatedUsdValue: null,
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(error, "BNB_BALANCE_RETRIEVAL_FAILED");
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
          chainId: BNB_CHAIN_ID,
          address: address.trim(),
          balances: holdings.map((holding) => ({
            asset: {
              chainId: BNB_CHAIN_ID,
              assetType: "fungible_token",
              assetId: `bnb:token:${holding.contractAddress}`,
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
                code: "BNB_TOKEN_BALANCE_COUNT_EXCEEDS_PROVIDER_LIMIT",
                message:
                  "This wallet holds more distinct tokens than Moralis's token-balances endpoint can enumerate - the token list below is incomplete, not an accurate 'this wallet holds no/few tokens' result.",
              },
            ]
          : [],
      );
    } catch (error) {
      return createErrorResult(error, "BNB_TOKEN_BALANCE_RETRIEVAL_FAILED");
    }
  }

  async getNftHoldings(
    address: string,
  ): Promise<ChainOperationResult<NftHoldingsResult>> {
    try {
      const holdings = await getEthereumNftHoldings(address, MORALIS_CHAIN);

      return createSuccessResult({
        chainId: BNB_CHAIN_ID,
        address: address.trim(),
        holdings: holdings.map((nft) => ({
          asset: createBnbNftAsset(nft),
          name: nft.name,
          collection: null,
          imageUrl: nft.imageUrl,
        })),
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(error, "BNB_NFT_RETRIEVAL_FAILED");
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
          chainId: BNB_CHAIN_ID,
          address: address.trim(),
          transactions,
          nextCursor,
          hasMore: nextCursor !== null,
          retrievedAt: new Date().toISOString(),
        },
        [
          {
            code: "BNB_TRANSACTION_COVERAGE_PARTIAL",
            message:
              "Transactions are listed but not yet parsed - transfers and program/contract IDs are not yet populated.",
          },
        ],
      );
    } catch (error) {
      return createErrorResult(error, "BNB_TRANSACTION_RETRIEVAL_FAILED");
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
            code: "BNB_TRANSACTION_ID_REQUIRED",
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
          chainId: BNB_CHAIN_ID,
          transactionId: cleanedTransactionId,
          transaction,
          retrievedAt: new Date().toISOString(),
        },
        transaction
          ? [
              {
                code: "BNB_TRANSACTION_COVERAGE_PARTIAL",
                message:
                  "The transaction was found but not yet parsed for transfers or contract interactions.",
              },
            ]
          : [
              {
                code: "BNB_TRANSACTION_NOT_FOUND",
                message: "No transaction data was returned for this transaction ID.",
              },
            ],
      );
    } catch (error) {
      return createErrorResult(error, "BNB_TRANSACTION_LOOKUP_FAILED");
    }
  }

  async getOldestTransaction(
    address: string,
  ): Promise<ChainOperationResult<OldestTransactionResult>> {
    try {
      // Same order=ASC&limit=1 single-call approach already live-verified
      // for Ethereum - Moralis's wallet-history endpoint supports it
      // identically for chain=bsc.
      const oldestTransaction = await getEthereumOldestTransaction(
        address,
        MORALIS_CHAIN,
      );

      if (!oldestTransaction) {
        return createSuccessResult({
          chainId: BNB_CHAIN_ID,
          address: address.trim(),
          transactionId: null,
          transaction: null,
          timestamp: null,
          retrievedAt: new Date().toISOString(),
        });
      }

      return createSuccessResult({
        chainId: BNB_CHAIN_ID,
        address: address.trim(),
        transactionId: oldestTransaction.hash,
        transaction: createUniversalTransaction(oldestTransaction),
        timestamp: oldestTransaction.blockTimestamp,
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(error, "BNB_OLDEST_TRANSACTION_FAILED");
    }
  }

  async getHealth(): Promise<ChainConnectorHealth> {
    const apiKeyAvailable = Boolean(process.env.MORALIS_API_KEY?.trim());

    return {
      chainId: BNB_CHAIN_ID,
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

export const bnbBlockchainConnector = new BnbBlockchainConnector();
