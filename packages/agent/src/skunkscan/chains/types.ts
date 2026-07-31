import {
  BlockchainFamily,
  BlockchainNetworkDefinition,
  ChainAdapterCapabilities,
  ChainAdapterSupportLevel,
  ChainIdentifier,
  UniversalAssetIdentifier,
  UniversalBlockchainAddress,
  UniversalNftHolding,
  UniversalTransaction,
} from "../types";

export type ChainOperationStatus =
  | "success"
  | "partial"
  | "unsupported"
  | "error";

export type ChainOperationWarning = {
  code: string;
  message: string;
};

export type ChainOperationError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type ChainOperationResult<T> = {
  status: ChainOperationStatus;
  data?: T;
  warnings: ChainOperationWarning[];
  error?: ChainOperationError;
};

export type AddressValidationResult = {
  chainId: ChainIdentifier;
  address: string;
  normalizedAddress?: string | null;
  isValid: boolean;
  addressType: UniversalBlockchainAddress["addressType"];
  memoOrTagRequired: boolean;
  reason?: string | null;
};

export type NativeBalanceResult = {
  chainId: ChainIdentifier;
  address: string;
  asset: UniversalAssetIdentifier;
  rawAmount: string;
  decimalAmount?: string | null;
  estimatedUsdValue?: number | null;
  retrievedAt: string;
};

export type TokenBalance = {
  asset: UniversalAssetIdentifier;
  rawAmount: string;
  decimalAmount?: string | null;
  estimatedUsdValue?: number | null;
};

export type TokenBalancesResult = {
  chainId: ChainIdentifier;
  address: string;
  balances: TokenBalance[];
  retrievedAt: string;
};

export type NftHoldingsResult = {
  chainId: ChainIdentifier;
  address: string;
  holdings: UniversalNftHolding[];
  retrievedAt: string;
};

export type TransactionPageRequest = {
  limit?: number;
  cursor?: string | null;
  beforeTransactionId?: string | null;
  afterTransactionId?: string | null;
  fromTimestamp?: number | null;
  toTimestamp?: number | null;
};

export type TransactionPageResult = {
  chainId: ChainIdentifier;
  address: string;
  transactions: UniversalTransaction[];
  nextCursor?: string | null;
  hasMore: boolean;
  retrievedAt: string;
};

export type TransactionLookupResult = {
  chainId: ChainIdentifier;
  transactionId: string;
  transaction?: UniversalTransaction | null;
  retrievedAt: string;
};

export type OldestTransactionResult = {
  chainId: ChainIdentifier;
  address: string;
  transactionId: string | null;
  transaction: UniversalTransaction | null;
  timestamp: number | null;
  retrievedAt: string;
};

export type ChainConnectorHealthStatus =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "unknown";

export type ChainConnectorHealth = {
  chainId: ChainIdentifier;
  status: ChainConnectorHealthStatus;
  checkedAt: string;
  providerNames: string[];
  notes: string[];
};

export type BlockchainConnectorDescriptor = {
  chainId: ChainIdentifier;
  family: BlockchainFamily;
  supportLevel: ChainAdapterSupportLevel;
  capabilities: ChainAdapterCapabilities;
  providerNames: string[];
  limitations: string[];
};

export interface BlockchainConnector {
  readonly network: BlockchainNetworkDefinition;

  readonly descriptor: BlockchainConnectorDescriptor;

  validateAddress(
    address: string,
  ): Promise<ChainOperationResult<AddressValidationResult>>;

  getNativeBalance(
    address: string,
  ): Promise<ChainOperationResult<NativeBalanceResult>>;

  getTokenBalances(
    address: string,
  ): Promise<ChainOperationResult<TokenBalancesResult>>;

  // Optional: chains without NFT support (or without an NFT-fetching
  // implementation yet) simply omit this method, and callers treat that
  // the same as an empty holdings list - no chain-name check required.
  getNftHoldings?(
    address: string,
  ): Promise<ChainOperationResult<NftHoldingsResult>>;

  getTransactions(
    address: string,
    request?: TransactionPageRequest,
  ): Promise<ChainOperationResult<TransactionPageResult>>;

    getTransaction(
    transactionId: string,
  ): Promise<ChainOperationResult<TransactionLookupResult>>;

  getOldestTransaction?(
    address: string,
  ): Promise<ChainOperationResult<OldestTransactionResult>>;

  getHealth(): Promise<ChainConnectorHealth>;
}

export interface BlockchainConnectorRegistry {
  register(connector: BlockchainConnector): void;

  unregister(chainId: ChainIdentifier): void;

  get(chainId: ChainIdentifier): BlockchainConnector | undefined;

  has(chainId: ChainIdentifier): boolean;

  list(): BlockchainConnector[];

  listEnabled(): BlockchainConnector[];
}
