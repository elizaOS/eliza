/**
 * Wallet domain methods — wallet addresses/balances, steward, registry
 * (ERC-8004), drop/mint, whitelist, twitter verify.
 */

import type {
  DropStatus,
  MintResult,
  VerificationResult,
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletConfigUpdateRequest,
  WalletMarketOverviewResponse,
  WalletNftsResponse,
} from "@elizaos/contracts";
import { ElizaClient } from "./client-base";
import type {
  RegistrationResult,
  RegistryConfig,
  RegistryStatus,
  VerificationMessageResponse,
  WhitelistStatus,
} from "./client-types-cloud";
import type { WalletExportResult } from "./client-types-config";
import { ApiError } from "./client-types-core";
import type {
  StewardApprovalActionResponse,
  StewardHistoryResponse,
  StewardPendingResponse,
  StewardSignRequest,
  StewardStatusResponse,
} from "./client-types-steward";
import type {
  BrowserWorkspaceSolanaMessageSignatureResult,
  BrowserWorkspaceSolanaTransactionResult,
  BrowserWorkspaceWalletMessageSignatureResult,
  BrowserWorkspaceWalletTransactionResult,
} from "./client-types-wallet";

// ---------------------------------------------------------------------------
// Declaration merging
// ---------------------------------------------------------------------------
declare module "./client-base.js" {
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
    getStewardStatus(): Promise<StewardStatusResponse>;
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
ElizaClient.prototype.getStewardStatus = async function (this: ElizaClient) {
  return this.fetch("/api/wallet/steward-status");
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
  const path = "/api/wallet/steward-pending-approvals";
  const approvals: StewardPendingResponse = [];
  let offset = 0;
  for (;;) {
    const res = await this.fetch<
      | StewardPendingResponse
      | {
          approvals: StewardPendingResponse;
          total: number;
          offset: number;
          limit: number;
        }
    >(offset === 0 ? path : `${path}?offset=${offset}`);
    // Older local hosts return the complete array directly.
    if (Array.isArray(res)) {
      if (offset === 0) return res;
      throw new ApiError({
        kind: "http",
        path,
        message: "Approval pagination changed during loading",
      });
    }
    if (
      !res ||
      !Array.isArray(res.approvals) ||
      !Number.isSafeInteger(res.total) ||
      res.total < 0 ||
      res.offset !== offset ||
      !Number.isSafeInteger(res.limit) ||
      res.limit <= 0 ||
      res.approvals.length > res.limit ||
      (res.approvals.length === 0 && offset < res.total)
    ) {
      throw new ApiError({
        kind: "http",
        path,
        message: "Invalid pending approvals response",
      });
    }
    approvals.push(...res.approvals);
    offset += res.approvals.length;
    if (offset >= res.total) return approvals;
  }
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
