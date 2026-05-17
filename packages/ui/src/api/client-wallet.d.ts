/**
 * Wallet domain methods — wallet addresses/balances, BSC trading, steward,
 * trading profile, registry (ERC-8004), drop/mint, whitelist, twitter verify.
 */
import type {
  BscTradeExecuteRequest,
  BscTradeExecuteResponse,
  BscTradePreflightResponse,
  BscTradeQuoteRequest,
  BscTradeQuoteResponse,
  BscTradeTxStatusResponse,
  BscTransferExecuteRequest,
  BscTransferExecuteResponse,
  DropStatus,
  MintResult,
  VerificationResult,
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletConfigUpdateRequest,
  WalletMarketOverviewResponse,
  WalletNftsResponse,
  WalletTradingProfileResponse,
  WalletTradingProfileSourceFilter,
  WalletTradingProfileWindow,
} from "@elizaos/shared";
import type {
  BrowserWorkspaceSolanaMessageSignatureResult,
  BrowserWorkspaceSolanaTransactionResult,
  BrowserWorkspaceWalletMessageSignatureResult,
  BrowserWorkspaceWalletTransactionResult,
} from "../components/pages/browser-workspace-wallet";
import type {
  ApplyProductionWalletDefaultsResponse,
  RegistrationResult,
  RegistryConfig,
  RegistryStatus,
  VerificationMessageResponse,
  WalletExportResult,
  WhitelistStatus,
} from "./client-types";
import type {
  StewardApprovalActionResponse,
  StewardBalanceResponse,
  StewardHistoryResponse,
  StewardPendingResponse,
  StewardSignRequest,
  StewardSignResponse,
  StewardStatusResponse,
  StewardTokenBalancesResponse,
  StewardWalletAddressesResponse,
  StewardWebhookEventsResponse,
  StewardWebhookEventType,
} from "./client-types-steward";

declare module "./client-base" {
  interface ElizaClient {
    getWalletAddresses(): Promise<WalletAddresses>;
    getWalletBalances(): Promise<WalletBalancesResponse>;
    getWalletNfts(): Promise<WalletNftsResponse>;
    getWalletConfig(): Promise<WalletConfigStatus>;
    updateWalletConfig(config: WalletConfigUpdateRequest): Promise<{
      ok: boolean;
    }>;
    refreshCloudWallets(): Promise<{
      ok: boolean;
      warnings?: string[];
    }>;
    setWalletPrimary(params: {
      chain: "evm" | "solana";
      source: "local" | "cloud";
    }): Promise<{
      ok: boolean;
    }>;
    generateWallet(params?: {
      chain?: "evm" | "solana" | "both";
      source?: "local" | "steward";
    }): Promise<{
      ok: boolean;
      wallets: Array<{
        chain: string;
        address: string;
      }>;
      source?: string;
      warnings?: string[];
    }>;
    exportWalletKeys(exportToken: string): Promise<WalletExportResult>;
    getBscTradePreflight(
      tokenAddress?: string,
    ): Promise<BscTradePreflightResponse>;
    getBscTradeQuote(
      request: BscTradeQuoteRequest,
    ): Promise<BscTradeQuoteResponse>;
    executeBscTrade(
      request: BscTradeExecuteRequest,
    ): Promise<BscTradeExecuteResponse>;
    executeBscTransfer(
      request: BscTransferExecuteRequest,
    ): Promise<BscTransferExecuteResponse>;
    getBscTradeTxStatus(hash: string): Promise<BscTradeTxStatusResponse>;
    getStewardStatus(): Promise<StewardStatusResponse>;
    getStewardAddresses(): Promise<StewardWalletAddressesResponse>;
    getStewardBalance(chainId?: number): Promise<StewardBalanceResponse>;
    getStewardTokens(chainId?: number): Promise<StewardTokenBalancesResponse>;
    getStewardWebhookEvents(opts?: {
      event?: StewardWebhookEventType;
      since?: number;
    }): Promise<StewardWebhookEventsResponse>;
    getStewardPolicies(): Promise<
      Array<{
        id: string;
        type: string;
        enabled: boolean;
        config: Record<string, unknown>;
      }>
    >;
    setStewardPolicies(
      policies: Array<{
        id: string;
        type: string;
        enabled: boolean;
        config: Record<string, unknown>;
      }>,
    ): Promise<void>;
    getStewardHistory(opts?: {
      status?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      records: StewardHistoryResponse;
      total: number;
      offset: number;
      limit: number;
    }>;
    getStewardPending(): Promise<StewardPendingResponse>;
    approveStewardTx(txId: string): Promise<StewardApprovalActionResponse>;
    rejectStewardTx(
      txId: string,
      reason?: string,
    ): Promise<StewardApprovalActionResponse>;
    signViaSteward(request: StewardSignRequest): Promise<StewardSignResponse>;
    signBrowserWalletMessage(
      message: string,
    ): Promise<BrowserWorkspaceWalletMessageSignatureResult>;
    signBrowserSolanaMessage(request: {
      message?: string;
      messageBase64?: string;
    }): Promise<BrowserWorkspaceSolanaMessageSignatureResult>;
    sendBrowserSolanaTransaction(request: {
      transactionBase64: string;
      cluster?: "mainnet" | "devnet" | "testnet";
      broadcast?: boolean;
      description?: string;
    }): Promise<BrowserWorkspaceSolanaTransactionResult>;
    sendBrowserWalletTransaction(
      request: StewardSignRequest,
    ): Promise<BrowserWorkspaceWalletTransactionResult>;
    getWalletMarketOverview(): Promise<WalletMarketOverviewResponse>;
    getWalletTradingProfile(
      window?: WalletTradingProfileWindow,
      source?: WalletTradingProfileSourceFilter,
    ): Promise<WalletTradingProfileResponse>;
    applyProductionWalletDefaults(): Promise<ApplyProductionWalletDefaultsResponse>;
    getRegistryStatus(): Promise<RegistryStatus>;
    registerAgent(params?: {
      name?: string;
      endpoint?: string;
      tokenURI?: string;
    }): Promise<RegistrationResult>;
    updateRegistryTokenURI(tokenURI: string): Promise<{
      ok: boolean;
      txHash: string;
    }>;
    syncRegistryProfile(params?: {
      name?: string;
      endpoint?: string;
      tokenURI?: string;
    }): Promise<{
      ok: boolean;
      txHash: string;
    }>;
    getRegistryConfig(): Promise<RegistryConfig>;
    getDropStatus(): Promise<DropStatus>;
    mintAgent(params?: {
      name?: string;
      endpoint?: string;
      shiny?: boolean;
    }): Promise<MintResult>;
    mintAgentWhitelist(params: {
      name?: string;
      endpoint?: string;
      proof: string[];
    }): Promise<MintResult>;
    getWhitelistStatus(): Promise<WhitelistStatus>;
    generateTwitterVerificationMessage(): Promise<VerificationMessageResponse>;
    verifyTwitter(tweetUrl: string): Promise<VerificationResult>;
  }
}
//# sourceMappingURL=client-wallet.d.ts.map
