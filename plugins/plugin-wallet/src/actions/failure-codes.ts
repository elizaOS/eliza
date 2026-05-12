/**
 * Single source of truth for action failure modes. Every error returned to the
 * planner carries a code from one of these unions; the `detail` string is for
 * humans, the code is for the planner to react on.
 *
 * See docs/architecture/wallet-and-trading.md §E.
 */

export type ValidateFailureCode =
  | "INVALID_PARAMS"
  | "PLUGIN_DISABLED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_AUTH_MISSING"
  | "WALLET_NOT_AVAILABLE"
  | "VENUE_NOT_SUPPORTED_ON_BACKEND"
  | "VENUE_NOT_SUPPORTED_FOR_KIND"
  | "POLICY_REQUIRES_APPROVAL"
  | "POLICY_BLOCKED"
  | "INSUFFICIENT_BALANCE"
  | "MARKET_CLOSED"
  | "INSTRUMENT_NOT_FOUND"
  | "LEVERAGE_OUT_OF_RANGE"
  | "SLIPPAGE_EXCEEDED"
  | "WITHDRAWAL_NOT_ALLOWLISTED"
  | "VENUE_GEO_RESTRICTED"
  | "INVALID_ADDRESS"
  | "TOKEN_NOT_SUPPORTED"
  | "POOL_NOT_FOUND"
  | "RANGE_OUT_OF_BOUNDS";

export type ActionFailureCode =
  | "PROVIDER_REJECTED"
  | "SIGNATURE_REJECTED"
  | "STEWARD_UNAVAILABLE"
  | "ROUTE_NOT_FOUND"
  | "TRANSACTION_REVERTED"
  | "TIMEOUT";

export type FailureCode = ValidateFailureCode | ActionFailureCode;

export const isValidateFailureCode = (
  code: string,
): code is ValidateFailureCode =>
  (
    [
      "INVALID_PARAMS",
      "PLUGIN_DISABLED",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_AUTH_MISSING",
      "WALLET_NOT_AVAILABLE",
      "VENUE_NOT_SUPPORTED_ON_BACKEND",
      "VENUE_NOT_SUPPORTED_FOR_KIND",
      "POLICY_REQUIRES_APPROVAL",
      "POLICY_BLOCKED",
      "INSUFFICIENT_BALANCE",
      "MARKET_CLOSED",
      "INSTRUMENT_NOT_FOUND",
      "LEVERAGE_OUT_OF_RANGE",
      "SLIPPAGE_EXCEEDED",
      "WITHDRAWAL_NOT_ALLOWLISTED",
      "VENUE_GEO_RESTRICTED",
      "INVALID_ADDRESS",
      "TOKEN_NOT_SUPPORTED",
      "POOL_NOT_FOUND",
      "RANGE_OUT_OF_BOUNDS",
    ] satisfies ReadonlyArray<ValidateFailureCode>
  ).includes(code as ValidateFailureCode);

export const isActionFailureCode = (code: string): code is ActionFailureCode =>
  (
    [
      "PROVIDER_REJECTED",
      "SIGNATURE_REJECTED",
      "STEWARD_UNAVAILABLE",
      "ROUTE_NOT_FOUND",
      "TRANSACTION_REVERTED",
      "TIMEOUT",
    ] satisfies ReadonlyArray<ActionFailureCode>
  ).includes(code as ActionFailureCode);
