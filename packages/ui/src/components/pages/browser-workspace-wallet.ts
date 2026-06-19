import type { WalletAddresses, WalletConfigStatus } from "@elizaos/shared";
import type {
  StewardSignResponse,
  StewardStatusResponse,
} from "../../api/client-types-steward";

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

export interface BrowserWorkspaceWalletTransactionResult
  extends Pick<
    StewardSignResponse,
    "approved" | "denied" | "pending" | "txHash" | "txId" | "violations"
  > {
  mode: "local-key" | "steward";
}

export interface BrowserWorkspaceWalletMessageSignatureResult {
  mode: "local-key";
  signature: string;
}

export interface BrowserWorkspaceSolanaMessageSignatureResult {
  address: string;
  mode: "local-key";
  signatureBase64: string;
}

export interface BrowserWorkspaceSolanaTransactionResult {
  address: string;
  mode: "local-key" | "steward";
  /** Base64-encoded fully-signed transaction (always present on success). */
  signedTransactionBase64: string;
  /**
   * Optional broadcast signature (base58) when the steward broadcast the
   * transaction. Omitted when the caller asked for signing only.
   */
  signature?: string;
  /** Cluster the steward signed/broadcast against. */
  cluster: "mainnet" | "devnet" | "testnet";
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

export interface BrowserWorkspaceWalletReadyPayload {
  type: typeof BROWSER_WALLET_READY_TYPE;
  state: BrowserWorkspaceWalletState;
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
  const parsed = trimmed.startsWith("0x")
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number(trimmed);
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
