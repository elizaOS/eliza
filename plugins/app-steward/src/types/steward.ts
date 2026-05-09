/**
 * Steward-specific wallet types.
 *
 * Steward wallet response types are surfaced here so steward consumers only
 * need this package's barrel imports.
 */

import type {
  StewardApprovalInfo,
  StewardBalanceResponse,
  StewardPolicyResult,
  StewardTokenBalancesResponse,
  StewardWalletAddressesResponse,
  StewardWebhookEvent,
  StewardWebhookEventsResponse,
  StewardWebhookEventType,
} from "@elizaos/shared";

export type {
  StewardApprovalInfo,
  StewardBalanceResponse,
  StewardPolicyResult,
  StewardTokenBalancesResponse,
  StewardWalletAddressesResponse,
  StewardWebhookEvent,
  StewardWebhookEventsResponse,
  StewardWebhookEventType,
};

/** Response from GET /api/wallet/steward-status. */
export interface StewardStatusResponse {
  configured: boolean;
  available: boolean;
  connected: boolean;
  baseUrl?: string;
  agentId?: string;
  evmAddress?: string;
  error?: string | null;
  walletAddresses?: { evm: string | null; solana: string | null };
  agentName?: string;
  vaultHealth?: "ok" | "degraded" | "error";
}

// ── Steward Transaction History & Approval Queue ─────────────────────────────

export type StewardTxStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "signed"
  | "broadcast"
  | "confirmed"
  | "failed";

/** A transaction record from the Steward vault history. */
export interface StewardTxRecord {
  id: string;
  agentId: string;
  status: StewardTxStatus;
  request: {
    agentId: string;
    tenantId: string;
    to: string;
    value: string;
    data?: string;
    chainId: number;
  };
  txHash?: string;
  policyResults: StewardPolicyResult[];
  createdAt: string;
  signedAt?: string;
  confirmedAt?: string;
}

/** A pending approval entry from the Steward approval queue. */
export interface StewardPendingApproval {
  queueId: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  transaction: StewardTxRecord;
}

/** Response shape for GET /api/wallet/steward-history */
export type StewardHistoryResponse = StewardTxRecord[];

/** Response shape for GET /api/wallet/steward-pending */
export type StewardPendingResponse = StewardPendingApproval[];

/** Response shape for POST /api/wallet/steward-approve and steward-reject */
export interface StewardApprovalActionResponse {
  ok: boolean;
  txHash?: string;
  error?: string;
}

// ── Steward Vault Signing ────────────────────────────────────────────────────

/** Request body for signing a transaction through the Steward vault. */
export interface StewardSignRequest {
  to: string;
  value: string;
  chainId: number;
  data?: string;
  broadcast?: boolean;
  description?: string;
}

/** Response from a Steward vault sign operation. */
export interface StewardSignResponse {
  approved: boolean;
  txHash?: string;
  txId?: string;
  pending?: boolean;
  denied?: boolean;
  violations?: Array<{ policy: string; reason: string }>;
}
