import type { WalletAddresses, WalletConfigStatus } from "@elizaos/shared";
import type {
  StewardSignResponse,
  StewardStatusResponse,
} from "../../api/client-types-steward";

export const BROWSER_WALLET_REQUEST_TYPE = "ELIZA_BROWSER_WALLET_REQUEST";
export const BROWSER_WALLET_RESPONSE_TYPE = "ELIZA_BROWSER_WALLET_RESPONSE";
export const BROWSER_WALLET_READY_TYPE = "ELIZA_BROWSER_WALLET_READY";

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
  if (stewardStatus?.connected) {
    return "steward";
  }
  if (
    (evmAddress && walletConfig?.executionReady) ||
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
      messageSigningAvailable: Boolean(
        evmAddress && walletConfig?.executionReady,
      ),
      transactionSigningAvailable: Boolean(
        evmAddress && walletConfig?.executionReady,
      ),
      chainSwitchingAvailable: Boolean(
        evmAddress && walletConfig?.executionReady,
      ),
      signingAvailable:
        Boolean(evmAddress && walletConfig?.executionReady) ||
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
