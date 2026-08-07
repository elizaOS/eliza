/** Browser-wallet signing results shared by the typed client and shell adapter. */

import type { StewardSignResponse } from "./client-types-steward";

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
  signedTransactionBase64: string;
  signature?: string;
  cluster: "mainnet" | "devnet" | "testnet";
}
