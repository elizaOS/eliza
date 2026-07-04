/**
 * Shared types for signing scopes, pending human-approval flows, and
 * canonical handler results used across `WalletBackend` and the audit/policy
 * modules. `SignScope` names each signing operation as `<domain>.<operation>`
 * for audit-log and policy attribution; `SignResult` is either a completed
 * `SignaturePayload` or a `PendingApproval` awaiting user confirmation.
 */
import type {
  ActionFailureCode,
  ValidateFailureCode,
} from "../actions/failure-codes.js";

/**
 * Stable identity for a signing operation. Used by the audit log and the
 * policy module. Format: "<domain>.<operation>".
 */
export type SignScope =
  | `hyperliquid.${string}`
  | `polymarket.${string}`
  | `lifi.${string}`
  | `jupiter.${string}`
  | `raydium.${string}`
  | `orca.${string}`
  | `meteora.${string}`
  | `aave.${string}`
  | `morpho.${string}`
  | `lp.${string}`
  | `lp-solana.${string}`
  | `lp-evm.${string}`
  | `clanker.${string}`
  | `mint.${string}`
  | `transfer.${string}`
  | `automation.${string}`
  | `x402.${string}`
  | `cctp.${string}`;

export interface ApprovalSummary {
  readonly title: string;
  readonly venue: string;
  readonly chainHint: "evm" | "solana" | "off-chain";
  readonly fields: ReadonlyArray<{ label: string; value: string }>;
}

export interface PendingApproval {
  readonly kind: "pending_approval";
  readonly approvalId: string;
  readonly scope: SignScope;
  readonly expiresAt: number;
  readonly summary: ApprovalSummary;
}

export interface SignaturePayload {
  readonly kind: "signature";
  readonly signature: `0x${string}`;
  readonly raw?: `0x${string}`;
}

export type SignResult = SignaturePayload | PendingApproval;

export type ValidateOutcome =
  | { ok: true }
  | { ok: false; reason: ValidateFailureCode; detail: string };

export type CanonicalHandlerResult<TData> =
  | { ok: true; data: TData }
  | { ok: false; error: ActionFailureCode; detail: string }
  | { ok: false; error: "PENDING_APPROVAL"; pending: PendingApproval };
