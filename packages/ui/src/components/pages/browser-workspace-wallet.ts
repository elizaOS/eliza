/**
 * Message protocol + wallet-state model shared by the browser-workspace host
 * and the wallet bridge hook. Defines the postMessage request/response/ready
 * message types, the supported EVM chain ids, and the
 * BrowserWorkspaceWalletState shape (EVM + Solana address/connected/signing
 * capability flags) that embedded iframes read to talk to the host wallet.
 */

import type { WalletAddresses, WalletConfigStatus } from "@elizaos/contracts";
import type { StewardStatusResponse } from "../../api/client-types-steward";

export type {
  BrowserWorkspaceSolanaMessageSignatureResult,
  BrowserWorkspaceSolanaTransactionResult,
  BrowserWorkspaceWalletMessageSignatureResult,
  BrowserWorkspaceWalletTransactionResult,
} from "../../api/client-types-wallet";
export const BROWSER_WALLET_REQUEST_TYPE = "ELIZA_BROWSER_WALLET_REQUEST";
export const BROWSER_WALLET_RESPONSE_TYPE = "ELIZA_BROWSER_WALLET_RESPONSE";
export const BROWSER_WALLET_READY_TYPE = "ELIZA_BROWSER_WALLET_READY";
export const DEFAULT_BROWSER_WORKSPACE_EVM_CHAIN_ID = 1;
export const SUPPORTED_BROWSER_WORKSPACE_EVM_CHAIN_IDS = [
  1, 10, 56, 137, 8453, 42161,
] as const;
const SUPPORTED_BROWSER_WORKSPACE_EVM_CHAIN_ID_SET = new Set<number>(
  SUPPORTED_BROWSER_WORKSPACE_EVM_CHAIN_IDS,
);
export type BrowserWorkspaceWalletMode =
  | "steward"
  | "local"
  | "blocked"
  | "none";
export interface BrowserWorkspaceWalletState {
  address: string | null;
  connected: boolean;
  evmAddress: string | null;
  evmConnected: boolean;
  mode: BrowserWorkspaceWalletMode;
  pendingApprovals: number;
  reason: string | null;
  messageSigningAvailable: boolean;
  transactionSigningAvailable: boolean;
  chainSwitchingAvailable: boolean;
  signingAvailable: boolean;
  solanaAddress: string | null;
  solanaConnected: boolean;
  solanaMessageSigningAvailable: boolean;
  solanaTransactionSigningAvailable: boolean;
}
export type BrowserWorkspaceWalletRpcMethod =
  | "eth_accounts"
  | "eth_requestAccounts"
  | "eth_chainId"
  | "eth_sendTransaction"
  | "personal_sign"
  | "eth_sign"
  | "eth_signTypedData"
  | "eth_signTypedData_v3"
  | "eth_signTypedData_v4"
  | "wallet_switchEthereumChain";
export type BrowserWorkspaceSolanaMethod =
  | "solana_connect"
  | "solana_signMessage"
  | "solana_signTransaction"
  | "solana_signAndSendTransaction";
export type BrowserWorkspaceWalletMethod =
  | "getState"
  | "requestAccounts"
  | "sendTransaction"
  | BrowserWorkspaceWalletRpcMethod
  | BrowserWorkspaceSolanaMethod;
export interface BrowserWorkspaceWalletRequest {
  type: typeof BROWSER_WALLET_REQUEST_TYPE;
  requestId: string;
  method: BrowserWorkspaceWalletMethod;
  params?: unknown;
}
export interface BrowserWorkspaceWalletResponse {
  type: typeof BROWSER_WALLET_RESPONSE_TYPE;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export const EMPTY_BROWSER_WORKSPACE_WALLET_STATE: BrowserWorkspaceWalletState =
  {
    address: null,
    connected: false,
    evmAddress: null,
    evmConnected: false,
    mode: "none",
    pendingApprovals: 0,
    reason: null,
    messageSigningAvailable: false,
    transactionSigningAvailable: false,
    chainSwitchingAvailable: false,
    signingAvailable: false,
    solanaAddress: null,
    solanaConnected: false,
    solanaMessageSigningAvailable: false,
    solanaTransactionSigningAvailable: false,
  };
export function getBrowserWorkspaceWalletAddress(
  walletAddresses: WalletAddresses | null,
  walletConfig: WalletConfigStatus | null,
  stewardStatus: StewardStatusResponse | null,
): string | null {
  return (
    stewardStatus?.walletAddresses?.evm ??
    stewardStatus?.evmAddress ??
    walletAddresses?.evmAddress ??
    walletConfig?.evmAddress ??
    null
  );
}
export function getBrowserWorkspaceSolanaAddress(
  walletAddresses: WalletAddresses | null,
  walletConfig: WalletConfigStatus | null,
  stewardStatus: StewardStatusResponse | null,
): string | null {
  return (
    stewardStatus?.walletAddresses?.solana ??
    walletAddresses?.solanaAddress ??
    walletConfig?.solanaAddress ??
    null
  );
}
export function resolveBrowserWorkspaceWalletMode(
  stewardStatus: StewardStatusResponse | null,
  evmAddress: string | null,
  solanaAddress: string | null,
  walletConfig: WalletConfigStatus | null,
): BrowserWorkspaceWalletMode {
  const evmMessageSigningAvailable = Boolean(
    evmAddress && walletConfig?.evmSigningCapability === "local",
  );
  const evmTransactionSigningAvailable = Boolean(
    evmAddress && walletConfig?.executionReady,
  );
  if (stewardStatus?.connected) {
    return "steward";
  }
  if (
    evmMessageSigningAvailable ||
    evmTransactionSigningAvailable ||
    (solanaAddress && walletConfig?.solanaSigningAvailable)
  ) {
    return "local";
  }
  if (evmAddress || solanaAddress) {
    return "blocked";
  }
  return "none";
}
export function buildBrowserWorkspaceWalletState(params: {
  pendingApprovals: number;
  stewardStatus: StewardStatusResponse | null;
  walletAddresses: WalletAddresses | null;
  walletConfig: WalletConfigStatus | null;
}): BrowserWorkspaceWalletState {
  const { pendingApprovals, stewardStatus, walletAddresses, walletConfig } =
    params;
  const evmAddress = getBrowserWorkspaceWalletAddress(
    walletAddresses,
    walletConfig,
    stewardStatus,
  );
  const solanaAddress = getBrowserWorkspaceSolanaAddress(
    walletAddresses,
    walletConfig,
    stewardStatus,
  );
  const address = evmAddress ?? solanaAddress;
  const mode = resolveBrowserWorkspaceWalletMode(
    stewardStatus,
    evmAddress,
    solanaAddress,
    walletConfig,
  );
  const evmConnected = Boolean(evmAddress);
  const solanaConnected = Boolean(solanaAddress);
  const evmMessageSigningAvailable = Boolean(
    evmAddress && walletConfig?.evmSigningCapability === "local",
  );
  const evmTransactionSigningAvailable = Boolean(
    evmAddress && walletConfig?.executionReady,
  );
  const solanaMessageSigningAvailable = Boolean(
    solanaAddress && walletConfig?.solanaSigningAvailable,
  );
  if (mode === "steward") {
    return {
      address,
      connected: evmConnected || solanaConnected,
      evmAddress,
      evmConnected,
      mode,
      pendingApprovals,
      reason: null,
      messageSigningAvailable: false,
      transactionSigningAvailable: true,
      chainSwitchingAvailable: true,
      signingAvailable: true,
      solanaAddress,
      solanaConnected,
      solanaMessageSigningAvailable: false,
      solanaTransactionSigningAvailable: solanaConnected,
    };
  }
  if (mode === "local") {
    const solanaTransactionSigningAvailable = Boolean(
      solanaAddress && walletConfig?.solanaSigningAvailable,
    );
    return {
      address,
      connected: evmConnected || solanaConnected,
      evmAddress,
      evmConnected,
      mode,
      pendingApprovals: 0,
      reason: null,
      messageSigningAvailable: evmMessageSigningAvailable,
      transactionSigningAvailable: evmTransactionSigningAvailable,
      chainSwitchingAvailable: evmTransactionSigningAvailable,
      signingAvailable:
        evmMessageSigningAvailable ||
        evmTransactionSigningAvailable ||
        solanaMessageSigningAvailable ||
        solanaTransactionSigningAvailable,
      solanaAddress,
      solanaConnected,
      solanaMessageSigningAvailable,
      solanaTransactionSigningAvailable,
    };
  }
  if (mode === "blocked") {
    return {
      address,
      connected: evmConnected || solanaConnected,
      evmAddress,
      evmConnected,
      mode,
      pendingApprovals: 0,
      reason:
        walletConfig?.executionBlockedReason?.trim() ||
        (solanaConnected && !solanaMessageSigningAvailable
          ? "Local Solana signing is unavailable."
          : "Local wallet execution is blocked."),
      messageSigningAvailable: false,
      transactionSigningAvailable: false,
      chainSwitchingAvailable: false,
      signingAvailable: false,
      solanaAddress,
      solanaConnected,
      solanaMessageSigningAvailable: false,
      solanaTransactionSigningAvailable: false,
    };
  }
  return {
    ...EMPTY_BROWSER_WORKSPACE_WALLET_STATE,
    mode,
    reason:
      stewardStatus?.configured && !stewardStatus.connected
        ? stewardStatus.error?.trim() || "Steward is unavailable."
        : "No wallet configured.",
  };
}
export function isBrowserWorkspaceWalletRequest(
  value: unknown,
): value is BrowserWorkspaceWalletRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    entry.type === BROWSER_WALLET_REQUEST_TYPE &&
    typeof entry.requestId === "string" &&
    typeof entry.method === "string"
  );
}
export function parseBrowserWorkspaceEvmChainId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("0x")) {
    const hex = trimmed.slice(2);
    // parseInt("1g", 16) is 1. A trailing junk character must not select chain 1.
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
    const parsed = Number.parseInt(hex, 16);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
export function formatBrowserWorkspaceEvmChainId(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}
export function isBrowserWorkspaceEvmChainSupported(chainId: number): boolean {
  return SUPPORTED_BROWSER_WORKSPACE_EVM_CHAIN_ID_SET.has(chainId);
}
export function getUnsupportedBrowserWorkspaceEvmChainError(
  chainId: number,
): string {
  return `Unsupported EVM chain ${chainId}. Supported chain IDs: ${SUPPORTED_BROWSER_WORKSPACE_EVM_CHAIN_IDS.join(", ")}.`;
}
export function resolveBrowserWorkspaceSignMessage(
  params: unknown,
  address: string | null,
): string | null {
  if (typeof params === "string") return params;
  if (!Array.isArray(params) || params.length === 0) return null;
  const [first, second] = params;
  if (typeof first === "string" && typeof second === "string" && address) {
    const normalizedAddress = address.toLowerCase();
    if (first.toLowerCase() === normalizedAddress) return second;
    if (second.toLowerCase() === normalizedAddress) return first;
  }
  return typeof first === "string" ? first : null;
}

export type BrowserWorkspaceSolanaCluster = "mainnet" | "devnet" | "testnet";

function matchBrowserWorkspaceSolanaCluster(
  value: unknown,
): BrowserWorkspaceSolanaCluster | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^solana:/, "");
  if (normalized === "mainnet" || normalized === "mainnet-beta")
    return "mainnet";
  if (normalized === "devnet" || normalized === "testnet") return normalized;
  if (URL.canParse(value)) {
    const endpoint = new URL(value);
    if (
      endpoint.protocol === "https:" &&
      !endpoint.port &&
      !endpoint.username &&
      !endpoint.password
    ) {
      if (endpoint.hostname === "api.mainnet-beta.solana.com") return "mainnet";
      if (endpoint.hostname === "api.devnet.solana.com") return "devnet";
      if (endpoint.hostname === "api.testnet.solana.com") return "testnet";
    }
  }
  return undefined;
}

/**
 * Resolve the Solana cluster a dApp expressed for signTransaction /
 * signAndSendTransaction. `cluster` wins over the legacy `chain` fallback.
 * An absent value (undefined/null on both) returns `{ cluster: null }` so
 * the request omits the field and the server's documented mainnet default
 * applies. A sent-but-unrecognizable value ("localnet", "mainent", 123)
 * returns `{ error }`: the bridge must reply with that error and never
 * forward the request, because omitting the field would silently route a
 * dApp that asked for some other network to mainnet.
 */
export function resolveBrowserWorkspaceSolanaCluster(
  params: unknown,
): { cluster: BrowserWorkspaceSolanaCluster | null } | { error: string } {
  const raw =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : undefined;
  const requested =
    raw && raw.cluster !== undefined && raw.cluster !== null
      ? raw.cluster
      : raw && raw.chain !== undefined && raw.chain !== null
        ? raw.chain
        : undefined;
  if (requested === undefined) return { cluster: null };
  const cluster = matchBrowserWorkspaceSolanaCluster(requested);
  if (!cluster) {
    return {
      error: `Unsupported Solana cluster ${JSON.stringify(String(requested))}: expected mainnet, devnet, or testnet.`,
    };
  }
  return { cluster };
}
