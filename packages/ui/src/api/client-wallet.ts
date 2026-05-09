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
import { ElizaClient } from "./client-base";
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

// ---------------------------------------------------------------------------
// Declaration merging
// ---------------------------------------------------------------------------

declare module "./client-base" {
  interface ElizaClient {
    getWalletAddresses(): Promise<WalletAddresses>;
    getWalletBalances(): Promise<WalletBalancesResponse>;
    getWalletNfts(): Promise<WalletNftsResponse>;
    getWalletConfig(): Promise<WalletConfigStatus>;
    updateWalletConfig(
      config: WalletConfigUpdateRequest,
    ): Promise<{ ok: boolean }>;
    refreshCloudWallets(): Promise<{
      ok: boolean;
      warnings?: string[];
    }>;
    setWalletPrimary(params: {
      chain: "evm" | "solana";
      source: "local" | "cloud";
    }): Promise<{ ok: boolean }>;
    generateWallet(params?: {
      chain?: "evm" | "solana" | "both";
      source?: "local" | "steward";
    }): Promise<{
      ok: boolean;
      wallets: Array<{ chain: string; address: string }>;
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
    updateRegistryTokenURI(
      tokenURI: string,
    ): Promise<{ ok: boolean; txHash: string }>;
    syncRegistryProfile(params?: {
      name?: string;
      endpoint?: string;
      tokenURI?: string;
    }): Promise<{ ok: boolean; txHash: string }>;
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

// ---------------------------------------------------------------------------
// Prototype augmentation
// ---------------------------------------------------------------------------

ElizaClient.prototype.getWalletAddresses = async function (this: ElizaClient) {
  return this.fetch("/api/wallet/addresses");
};

ElizaClient.prototype.getWalletBalances = async function (this: ElizaClient) {
  return this.fetch("/api/wallet/balances");
};

ElizaClient.prototype.getWalletNfts = async function (this: ElizaClient) {
  return this.fetch("/api/wallet/nfts");
};

ElizaClient.prototype.getWalletConfig = async function (this: ElizaClient) {
  return this.fetch("/api/wallet/config");
};

ElizaClient.prototype.updateWalletConfig = async function (
  this: ElizaClient,
  config,
) {
  return this.fetch("/api/wallet/config", {
    method: "PUT",
    body: JSON.stringify(config),
  });
};

ElizaClient.prototype.refreshCloudWallets = async function (this: ElizaClient) {
  return this.fetch("/api/wallet/refresh-cloud", {
    method: "POST",
  });
};

ElizaClient.prototype.setWalletPrimary = async function (
  this: ElizaClient,
  params,
) {
  return this.fetch("/api/wallet/primary", {
    method: "POST",
    body: JSON.stringify(params),
  });
};

ElizaClient.prototype.generateWallet = async function (
  this: ElizaClient,
  params = {},
) {
  return this.fetch("/api/wallet/generate", {
    method: "POST",
    body: JSON.stringify(params),
  });
};

ElizaClient.prototype.exportWalletKeys = async function (
  this: ElizaClient,
  exportToken,
) {
  return this.fetch("/api/wallet/export", {
    method: "POST",
    body: JSON.stringify({ confirm: true, exportToken }),
  });
};

ElizaClient.prototype.getBscTradePreflight = async function (
  this: ElizaClient,
  tokenAddress?,
) {
  return this.fetch("/api/wallet/trade/preflight", {
    method: "POST",
    body: JSON.stringify(
      tokenAddress?.trim() ? { tokenAddress: tokenAddress.trim() } : {},
    ),
  });
};

ElizaClient.prototype.getBscTradeQuote = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/wallet/trade/quote", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.executeBscTrade = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/wallet/trade/execute", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.executeBscTransfer = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/wallet/transfer/execute", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.getBscTradeTxStatus = async function (
  this: ElizaClient,
  hash,
) {
  return this.fetch(
    `/api/wallet/trade/tx-status?hash=${encodeURIComponent(hash)}`,
  );
};

ElizaClient.prototype.getStewardStatus = async function (this: ElizaClient) {
  return this.fetch("/api/wallet/steward-status");
};

ElizaClient.prototype.getStewardAddresses = async function (this: ElizaClient) {
  return this.fetch("/api/wallet/steward-addresses");
};

ElizaClient.prototype.getStewardBalance = async function (
  this: ElizaClient,
  chainId?,
) {
  const qs =
    chainId == null ? "" : `?chainId=${encodeURIComponent(String(chainId))}`;
  return this.fetch(`/api/wallet/steward-balances${qs}`);
};

ElizaClient.prototype.getStewardTokens = async function (
  this: ElizaClient,
  chainId?,
) {
  const qs =
    chainId == null ? "" : `?chainId=${encodeURIComponent(String(chainId))}`;
  return this.fetch(`/api/wallet/steward-tokens${qs}`);
};

ElizaClient.prototype.getStewardWebhookEvents = async function (
  this: ElizaClient,
  opts?,
) {
  const params = new URLSearchParams();
  if (opts?.event) params.set("event", opts.event);
  if (opts?.since != null) params.set("since", String(opts.since));
  const qs = params.toString();
  return this.fetch(`/api/wallet/steward-webhook-events${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.getStewardPolicies = async function (this: ElizaClient) {
  return this.fetch("/api/wallet/steward-policies");
};

ElizaClient.prototype.setStewardPolicies = async function (
  this: ElizaClient,
  policies,
) {
  await this.fetch("/api/wallet/steward-policies", {
    method: "PUT",
    body: JSON.stringify({ policies }),
  });
};

ElizaClient.prototype.getStewardHistory = async function (
  this: ElizaClient,
  opts?,
) {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.offset != null) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return this.fetch(`/api/wallet/steward-tx-records${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.getStewardPending = async function (this: ElizaClient) {
  return this.fetch("/api/wallet/steward-pending-approvals");
};

ElizaClient.prototype.approveStewardTx = async function (
  this: ElizaClient,
  txId,
) {
  return this.fetch("/api/wallet/steward-approve-tx", {
    method: "POST",
    body: JSON.stringify({ txId }),
  });
};

ElizaClient.prototype.rejectStewardTx = async function (
  this: ElizaClient,
  txId,
  reason?,
) {
  return this.fetch("/api/wallet/steward-deny-tx", {
    method: "POST",
    body: JSON.stringify({ txId, reason }),
  });
};

ElizaClient.prototype.signViaSteward = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/wallet/steward-sign", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.sendBrowserWalletTransaction = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/wallet/browser-transaction", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.signBrowserWalletMessage = async function (
  this: ElizaClient,
  message,
) {
  return this.fetch("/api/wallet/browser-sign-message", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
};

ElizaClient.prototype.signBrowserSolanaMessage = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/wallet/browser-solana-sign-message", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.sendBrowserSolanaTransaction = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/wallet/browser-solana-transaction", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.getWalletMarketOverview = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/wallet/market-overview");
};

ElizaClient.prototype.getWalletTradingProfile = async function (
  this: ElizaClient,
  window = "30d",
  source = "all",
) {
  const params = new URLSearchParams({ window, source });
  return this.fetch(`/api/wallet/trading/profile?${params.toString()}`);
};

ElizaClient.prototype.applyProductionWalletDefaults = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/wallet/production-defaults", {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
};

ElizaClient.prototype.getRegistryStatus = async function (this: ElizaClient) {
  return this.fetch("/api/registry/status");
};

ElizaClient.prototype.registerAgent = async function (
  this: ElizaClient,
  params?,
) {
  return this.fetch("/api/registry/register", {
    method: "POST",
    body: JSON.stringify(params ?? {}),
  });
};

ElizaClient.prototype.updateRegistryTokenURI = async function (
  this: ElizaClient,
  tokenURI,
) {
  return this.fetch("/api/registry/update-uri", {
    method: "POST",
    body: JSON.stringify({ tokenURI }),
  });
};

ElizaClient.prototype.syncRegistryProfile = async function (
  this: ElizaClient,
  params?,
) {
  return this.fetch("/api/registry/sync", {
    method: "POST",
    body: JSON.stringify(params ?? {}),
  });
};

ElizaClient.prototype.getRegistryConfig = async function (this: ElizaClient) {
  return this.fetch("/api/registry/config");
};

ElizaClient.prototype.getDropStatus = async function (this: ElizaClient) {
  return this.fetch("/api/drop/status");
};

ElizaClient.prototype.mintAgent = async function (this: ElizaClient, params?) {
  return this.fetch("/api/drop/mint", {
    method: "POST",
    body: JSON.stringify(params ?? {}),
  });
};

ElizaClient.prototype.mintAgentWhitelist = async function (
  this: ElizaClient,
  params,
) {
  return this.fetch("/api/drop/mint-whitelist", {
    method: "POST",
    body: JSON.stringify(params),
  });
};

ElizaClient.prototype.getWhitelistStatus = async function (this: ElizaClient) {
  return this.fetch("/api/whitelist/status");
};

ElizaClient.prototype.generateTwitterVerificationMessage = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/whitelist/twitter/message", { method: "POST" });
};

ElizaClient.prototype.verifyTwitter = async function (
  this: ElizaClient,
  tweetUrl,
) {
  return this.fetch("/api/whitelist/twitter/verify", {
    method: "POST",
    body: JSON.stringify({ tweetUrl }),
  });
};
