import type { WalletAddresses, WalletConfigStatus } from "@elizaos/shared";
import type {
  StewardSignResponse,
  StewardStatusResponse,
} from "../../api/client-types-steward";
export declare const BROWSER_WALLET_REQUEST_TYPE =
  "ELIZA_BROWSER_WALLET_REQUEST";
export declare const BROWSER_WALLET_RESPONSE_TYPE =
  "ELIZA_BROWSER_WALLET_RESPONSE";
export declare const BROWSER_WALLET_READY_TYPE = "ELIZA_BROWSER_WALLET_READY";
export declare const DEFAULT_BROWSER_WORKSPACE_EVM_CHAIN_ID = 1;
export declare const SUPPORTED_BROWSER_WORKSPACE_EVM_CHAIN_IDS: readonly [
  1,
  10,
  56,
  137,
  8453,
  42161,
];
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
export declare const EMPTY_BROWSER_WORKSPACE_WALLET_STATE: BrowserWorkspaceWalletState;
export declare function getBrowserWorkspaceWalletAddress(
  walletAddresses: WalletAddresses | null,
  walletConfig: WalletConfigStatus | null,
  stewardStatus: StewardStatusResponse | null,
): string | null;
export declare function getBrowserWorkspaceSolanaAddress(
  walletAddresses: WalletAddresses | null,
  walletConfig: WalletConfigStatus | null,
  stewardStatus: StewardStatusResponse | null,
): string | null;
export declare function resolveBrowserWorkspaceWalletMode(
  stewardStatus: StewardStatusResponse | null,
  evmAddress: string | null,
  solanaAddress: string | null,
  walletConfig: WalletConfigStatus | null,
): BrowserWorkspaceWalletMode;
export declare function buildBrowserWorkspaceWalletState(params: {
  pendingApprovals: number;
  stewardStatus: StewardStatusResponse | null;
  walletAddresses: WalletAddresses | null;
  walletConfig: WalletConfigStatus | null;
}): BrowserWorkspaceWalletState;
export declare function isBrowserWorkspaceWalletRequest(
  value: unknown,
): value is BrowserWorkspaceWalletRequest;
export declare function parseBrowserWorkspaceEvmChainId(
  value: unknown,
): number | null;
export declare function formatBrowserWorkspaceEvmChainId(
  chainId: number,
): string;
export declare function isBrowserWorkspaceEvmChainSupported(
  chainId: number,
): boolean;
export declare function getUnsupportedBrowserWorkspaceEvmChainError(
  chainId: number,
): string;
export declare function resolveBrowserWorkspaceSignMessage(
  params: unknown,
  address: string | null,
): string | null;
//# sourceMappingURL=browser-workspace-wallet.d.ts.map
