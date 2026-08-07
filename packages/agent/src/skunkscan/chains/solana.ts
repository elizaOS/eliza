import {
  ChainAdapterCapabilities,
  UniversalAssetIdentifier,
  UniversalBlockchainAddress,
  UniversalTransaction,
  UniversalTransfer,
} from "../types";

import {
  getSolanaBalance,
  getSolanaNftHoldings,
  getSolanaOldestKnownSignature,
  getSolanaParsedTransactions,
  getSolanaRecentSignatures,
  getSolanaTokenHoldings,
  SolanaParsedTransaction,
  SolanaSignatureResult,
} from "../helius";

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

const SOLANA_CHAIN_ID = "solana";
const LAMPORTS_PER_SOL = 1_000_000_000;

const SOLANA_NATIVE_ASSET: UniversalAssetIdentifier = {
  chainId: SOLANA_CHAIN_ID,
  assetType: "native",
  assetId: "solana:native:SOL",
  symbol: "SOL",
  name: "Solana",
  decimals: 9,
  contractAddress: null,
  tokenId: null,
};

const SOLANA_CAPABILITIES: ChainAdapterCapabilities = {
  addressValidation: true,
  balanceRetrieval: true,
  transactionRetrieval: true,
  transactionParsing: true,
  tokenRetrieval: true,
  nftRetrieval: true,
  protocolDetection: false,
  internalTransferDetection: false,
  historicalTransactionRetrieval: true,
};

function isValidSolanaAddress(address: string): boolean {
  const normalizedAddress = address.trim();

  if (
    normalizedAddress.length < 32 ||
    normalizedAddress.length > 44
  ) {
    return false;
  }

  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(normalizedAddress);
}

function createUniversalAddress(
  address: string,
): UniversalBlockchainAddress {
  const normalizedAddress = address.trim();

  return {
    chainId: SOLANA_CHAIN_ID,
    address: normalizedAddress,
    normalizedAddress,
    addressType: "unknown",
    isValid: isValidSolanaAddress(normalizedAddress),
    metadata: {
      source: "helius",
    },
  };
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
      : "Unknown Solana connector error";

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

function findParsedTransaction(
  signature: string,
  parsedTransactions: SolanaParsedTransaction[],
): SolanaParsedTransaction | undefined {
  return parsedTransactions.find(
    (transaction) => transaction.signature === signature,
  );
}

function createNativeTransfers(
  transactionId: string,
  investigatedAddress: string | null,
  parsedTransaction?: SolanaParsedTransaction,
): UniversalTransfer[] {
  const nativeTransfers =
    parsedTransaction?.nativeTransfers ?? [];

  return nativeTransfers.map((transfer, index) => {
    const fromAddress =
      typeof transfer.fromUserAccount === "string"
        ? transfer.fromUserAccount
        : null;

    const toAddress =
      typeof transfer.toUserAccount === "string"
        ? transfer.toUserAccount
        : null;

    const lamports =
      typeof transfer.amount === "number"
        ? transfer.amount
        : 0;

    let direction: UniversalTransfer["direction"] =
      "unknown";

    if (
      investigatedAddress &&
      fromAddress === investigatedAddress &&
      toAddress === investigatedAddress
    ) {
      direction = "self";
    } else if (
      investigatedAddress &&
      fromAddress === investigatedAddress
    ) {
      direction = "outgoing";
    } else if (
      investigatedAddress &&
      toAddress === investigatedAddress
    ) {
      direction = "incoming";
    }

    return {
      id: `${transactionId}:native:${index}`,
      chainId: SOLANA_CHAIN_ID,
      transactionId,
      transferIndex: index,
      transferType: "native_transfer",
      direction,
      asset: SOLANA_NATIVE_ASSET,
      amount: {
        rawAmount: String(lamports),
        decimalAmount: String(
          lamports / LAMPORTS_PER_SOL,
        ),
      },
      from: fromAddress
        ? createUniversalAddress(fromAddress)
        : null,
      to: toAddress
        ? createUniversalAddress(toAddress)
        : null,
      success: true,
      metadata: {
        provider: "helius",
      },
    };
  });
}

function createCounterparties(
  transfers: UniversalTransfer[],
  investigatedAddress: string | null,
): UniversalBlockchainAddress[] {
  const addresses = new Map<
    string,
    UniversalBlockchainAddress
  >();

  for (const transfer of transfers) {
    const candidates = [transfer.from, transfer.to];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      if (
        investigatedAddress &&
        candidate.normalizedAddress ===
          investigatedAddress
      ) {
        continue;
      }

      addresses.set(
        candidate.normalizedAddress,
        candidate,
      );
    }
  }

  return Array.from(addresses.values());
}

function createUniversalTransaction(
  signatureResult: SolanaSignatureResult,
  investigatedAddress: string | null,
  parsedTransaction?: SolanaParsedTransaction,
): UniversalTransaction {
  const transfers = createNativeTransfers(
    signatureResult.signature,
    investigatedAddress,
    parsedTransaction,
  );

  const initiator =
    transfers.find((transfer) => transfer.from)
      ?.from ?? null;

  const timestamp =
    typeof parsedTransaction?.timestamp === "number"
      ? parsedTransaction.timestamp
      : typeof signatureResult.blockTime === "number"
        ? signatureResult.blockTime
        : null;

  return {
    chainId: SOLANA_CHAIN_ID,
    transactionId: signatureResult.signature,
    blockIdentifier:
      typeof signatureResult.slot === "number"
        ? String(signatureResult.slot)
        : null,
    blockHeight:
      typeof signatureResult.slot === "number"
        ? signatureResult.slot
        : null,
    transactionIndex: null,
    timestamp,
    status:
      signatureResult.err === undefined
        ? "unknown"
        : signatureResult.err === null
          ? "confirmed"
          : "failed",
    classifications:
      transfers.length > 0
        ? ["transfer"]
        : ["unknown"],
    initiator,
    signers: [],
    counterparties: createCounterparties(
      transfers,
      investigatedAddress,
    ),
    transfers,
    fee: null,
    programOrContractIds: [],
    memo: null,
    rawDataAvailable:
      parsedTransaction !== undefined,
    metadata: {
      provider: "helius",
      slot: signatureResult.slot ?? null,
      parseCoverage:
        transfers.length > 0
          ? "native_transfers"
          : "limited",
    },
  };
}

export const solanaConnectorDescriptor: BlockchainConnectorDescriptor =
  {
    chainId: SOLANA_CHAIN_ID,
    family: "solana",
    supportLevel: "partial",
    capabilities: SOLANA_CAPABILITIES,
    providerNames: ["Helius"],
    limitations: [
      "The connector currently normalizes native SOL transfers only.",
      "SPL token transfers are not yet included in normalized transactions.",
      "Program and protocol classifications are not yet connected.",
      "NFT transaction normalization is not yet connected.",
      "Transaction fee extraction is not yet connected.",
    ],
  };

export class SolanaBlockchainConnector
  implements BlockchainConnector
{
  readonly network = {
    id: SOLANA_CHAIN_ID,
    name: "Solana",
    family: "solana" as const,
    networkType: "mainnet" as const,
    addressModel: "account" as const,
    nativeAssetSymbol: "SOL",
    nativeAssetDecimals: 9,
    finalityType: "deterministic" as const,
    capabilities: {
      supportsNativeAsset: true,
      supportsFungibleTokens: true,
      supportsNfts: true,
      supportsSmartContracts: true,
      supportsDefi: true,
      supportsStaking: true,
      supportsMemoOrTag: true,
      supportsInternalTransactions: false,
      supportsTransactionLogs: true,
      supportsTokenApprovals: false,
    },
    explorerUrl: "https://solscan.io",
    chainReference: "solana-mainnet-beta",
    isEnabled: true,
  };

  readonly descriptor =
    solanaConnectorDescriptor;

  async validateAddress(
    address: string,
  ): Promise<
    ChainOperationResult<AddressValidationResult>
  > {
    const normalizedAddress = address.trim();
    const isValid =
      isValidSolanaAddress(normalizedAddress);

    return createSuccessResult({
      chainId: SOLANA_CHAIN_ID,
      address,
      normalizedAddress:
        normalizedAddress || null,
      isValid,
      addressType: "unknown",
      memoOrTagRequired: false,
      reason: isValid
        ? null
        : "Address does not match the expected Solana Base58 format and length.",
    });
  }

  async getNativeBalance(
    address: string,
  ): Promise<
    ChainOperationResult<NativeBalanceResult>
  > {
    try {
      const balance =
        await getSolanaBalance(address);

      return createSuccessResult({
        chainId: SOLANA_CHAIN_ID,
        address: balance.address,
        asset: SOLANA_NATIVE_ASSET,
        rawAmount: String(balance.lamports),
        decimalAmount: String(balance.sol),
        estimatedUsdValue: null,
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(
        error,
        "SOLANA_BALANCE_RETRIEVAL_FAILED",
      );
    }
  }

  async getTokenBalances(
    address: string,
  ): Promise<
    ChainOperationResult<TokenBalancesResult>
  > {
    try {
      const holdings =
        await getSolanaTokenHoldings(address);

      return createSuccessResult({
        chainId: SOLANA_CHAIN_ID,
        address: address.trim(),
        balances: holdings.map((holding) => ({
          asset: {
            chainId: SOLANA_CHAIN_ID,
            assetType: "fungible_token",
            assetId: `solana:token:${holding.mint}`,
            decimals: holding.decimals,
            contractAddress: holding.mint,
            tokenId: null,
          },
          rawAmount: holding.rawAmount,
          decimalAmount: String(holding.amount),
          estimatedUsdValue: null,
        })),
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(
        error,
        "SOLANA_TOKEN_BALANCE_RETRIEVAL_FAILED",
      );
    }
  }

  async getNftHoldings(
    address: string,
  ): Promise<
    ChainOperationResult<NftHoldingsResult>
  > {
    try {
      const holdings =
        await getSolanaNftHoldings(address);

      return createSuccessResult({
        chainId: SOLANA_CHAIN_ID,
        address: address.trim(),
        holdings: holdings.map((nft) => ({
          asset: {
            chainId: SOLANA_CHAIN_ID,
            assetType: "nft",
            assetId: `solana:nft:${nft.mint}`,
            decimals: null,
            contractAddress: null,
            tokenId: nft.mint,
          },
          name: nft.name,
          collection: nft.collection,
          imageUrl: nft.imageUrl,
        })),
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(
        error,
        "SOLANA_NFT_RETRIEVAL_FAILED",
      );
    }
  }

  async getTransactions(
    address: string,
    request: TransactionPageRequest = {},
  ): Promise<
    ChainOperationResult<TransactionPageResult>
  > {
    try {
      const requestedLimit =
        typeof request.limit === "number"
          ? request.limit
          : 20;

      const limit = Math.max(
        1,
        Math.min(100, requestedLimit),
      );

      const signatures =
        await getSolanaRecentSignatures(
          address,
          limit,
        );

      const parsedTransactions =
        await getSolanaParsedTransactions(
          signatures.map(
            (transaction) =>
              transaction.signature,
          ),
        );

      const normalizedAddress = address.trim();

      const transactions = signatures.map(
        (signatureResult) =>
          createUniversalTransaction(
            signatureResult,
            normalizedAddress,
            findParsedTransaction(
              signatureResult.signature,
              parsedTransactions,
            ),
          ),
      );

      const lastTransaction =
        signatures[signatures.length - 1];

      return createSuccessResult(
        {
          chainId: SOLANA_CHAIN_ID,
          address: normalizedAddress,
          transactions,
          nextCursor:
            lastTransaction?.signature ?? null,
          hasMore: signatures.length === limit,
          retrievedAt:
            new Date().toISOString(),
        },
        [
          {
            code:
              "SOLANA_TRANSACTION_COVERAGE_PARTIAL",
            message:
              "Normalized transaction output currently includes native SOL transfers. SPL transfers and program classifications will be added later.",
          },
        ],
      );
    } catch (error) {
      return createErrorResult(
        error,
        "SOLANA_TRANSACTION_RETRIEVAL_FAILED",
      );
    }
  }

  async getTransaction(
    transactionId: string,
  ): Promise<
    ChainOperationResult<TransactionLookupResult>
  > {
    try {
      const cleanedTransactionId =
        transactionId.trim();

      if (!cleanedTransactionId) {
        return {
          status: "error",
          warnings: [],
          error: {
            code:
              "SOLANA_TRANSACTION_ID_REQUIRED",
            message:
              "Transaction ID is required.",
            retryable: false,
          },
        };
      }

      const parsedTransactions =
        await getSolanaParsedTransactions([
          cleanedTransactionId,
        ]);

      const parsedTransaction =
        parsedTransactions[0];

      const transaction =
        parsedTransaction
          ? createUniversalTransaction(
              {
                signature:
                  cleanedTransactionId,
                blockTime:
                  parsedTransaction.timestamp ??
                  null,
              },
              null,
              parsedTransaction,
            )
          : null;

      return createSuccessResult(
        {
          chainId: SOLANA_CHAIN_ID,
          transactionId:
            cleanedTransactionId,
          transaction,
          retrievedAt:
            new Date().toISOString(),
        },
        transaction
          ? [
              {
                code:
                  "SOLANA_TRANSACTION_COVERAGE_PARTIAL",
                message:
                  "The transaction was normalized with currently available Helius parsed data.",
              },
            ]
          : [
              {
                code:
                  "SOLANA_TRANSACTION_NOT_FOUND",
                message:
                  "No parsed transaction data was returned for this transaction ID.",
              },
            ],
      );
    } catch (error) {
      return createErrorResult(
        error,
        "SOLANA_TRANSACTION_LOOKUP_FAILED",
      );
    }
  }

    async getOldestTransaction(
    address: string,
  ): Promise<
    ChainOperationResult<OldestTransactionResult>
  > {
    try {
      const oldestSignature =
        await getSolanaOldestKnownSignature(
          address,
        );

      // getSolanaOldestKnownSignature always returns an object (never
      // null/undefined) - the real "no oldest transaction found" signal is
      // an empty/null .signature field, not a falsy return value itself.
      // Previously checked `!oldestSignature`, which could never trigger.
      if (!oldestSignature.signature) {
        return createSuccessResult({
          chainId: SOLANA_CHAIN_ID,
          address: address.trim(),
          transactionId: null,
          transaction: null,
          timestamp: null,
          retrievedAt:
            new Date().toISOString(),
        });
      }

      const transactionResult =
        await this.getTransaction(
          oldestSignature.signature,
        );

      return createSuccessResult({
        chainId: SOLANA_CHAIN_ID,
        address: address.trim(),
        transactionId:
          oldestSignature.signature,
        transaction:
          transactionResult.data
            ?.transaction ?? null,
        timestamp:
          oldestSignature.blockTime ?? null,
        retrievedAt:
          new Date().toISOString(),
      });
    } catch (error) {
      return createErrorResult(
        error,
        "SOLANA_OLDEST_TRANSACTION_FAILED",
      );
    }
  }
  
  async getHealth(): Promise<ChainConnectorHealth> {
    const apiKeyAvailable =
      Boolean(
        process.env.HELIUS_API_KEY?.trim(),
      );

    return {
      chainId: SOLANA_CHAIN_ID,
      status: apiKeyAvailable
        ? "healthy"
        : "unavailable",
      checkedAt: new Date().toISOString(),
      providerNames: ["Helius"],
      notes: apiKeyAvailable
        ? [
            "Helius API key is configured.",
            "No network request was performed during this health check.",
          ]
        : [
            "HELIUS_API_KEY is not configured.",
          ],
    };
  }
}

export const solanaBlockchainConnector =
  new SolanaBlockchainConnector();
