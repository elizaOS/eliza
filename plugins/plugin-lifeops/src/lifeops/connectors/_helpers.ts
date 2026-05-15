/**
 * Internal helpers for connector wrappers.
 *
 * Provides translation from service-mixin bespoke status shapes into the
 * canonical contract:
 *
 *   - {@link ConnectorStatus} — uniform `ok | degraded | disconnected` triple.
 *   - {@link DispatchResult}  — typed success / failure for `send`.
 */
import { LifeOpsServiceError } from "../service.js";
import type { ConnectorStatus, DispatchResult } from "./contract.js";

export type LegacyConnectorStatus = {
  connected?: boolean;
  reason?: string | null;
  authError?: string | null;
  degradations?: ReadonlyArray<{
    axis: string;
    code: string;
    message: string;
    retryable: boolean;
  }>;
};

/**
 * Translate any legacy `getXConnectorStatus()` shape into a
 * {@link ConnectorStatus}. Status mapping:
 *
 *   - `connected: true` and no degradations → `ok`.
 *   - `connected: true` with one or more degradations → `degraded`.
 *   - `connected: false` → `disconnected`.
 */
export function legacyStatusToConnectorStatus(
  status: LegacyConnectorStatus,
): ConnectorStatus {
  const observedAt = new Date().toISOString();
  if (status.connected !== true) {
    return {
      state: "disconnected",
      message: status.authError ?? status.reason ?? undefined,
      observedAt,
    };
  }
  if (status.degradations && status.degradations.length > 0) {
    return {
      state: "degraded",
      message: status.degradations[0]?.message,
      observedAt,
    };
  }
  return { state: "ok", observedAt };
}

/**
 * Translate a thrown {@link LifeOpsServiceError} (or generic Error) into the
 * {@link DispatchResult} failure shape.
 *
 * Status code → failure-reason mapping mirrors the dispatch-policy decisions:
 *   - 401 / 410 / token-expired → `auth_expired` (userActionable: true).
 *   - 403 → `auth_expired` (missing permission still requires user action).
 *   - 404 → `unknown_recipient`.
 *   - 409 → `disconnected` (plugin not connected).
 *   - 429 → `rate_limited` with `retryAfterMinutes: 5` default.
 *   - 503 → `disconnected` (service unavailable / runtime delegation gone).
 *   - everything else → `transport_error`.
 */
export function errorToDispatchResult(error: unknown): DispatchResult {
  if (error instanceof LifeOpsServiceError) {
    const message = error.message;
    switch (error.status) {
      case 401:
      case 410:
        return {
          ok: false,
          reason: "auth_expired",
          userActionable: true,
          message,
        };
      case 403:
        return {
          ok: false,
          reason: "auth_expired",
          userActionable: true,
          message,
        };
      case 404:
        return {
          ok: false,
          reason: "unknown_recipient",
          userActionable: true,
          message,
        };
      case 409:
        return {
          ok: false,
          reason: "disconnected",
          userActionable: true,
          message,
        };
      case 429:
        return {
          ok: false,
          reason: "rate_limited",
          retryAfterMinutes: 5,
          userActionable: false,
          message,
        };
      case 503:
        return {
          ok: false,
          reason: "disconnected",
          userActionable: true,
          message,
        };
      default:
        return {
          ok: false,
          reason: "transport_error",
          userActionable: false,
          message,
        };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    reason: "transport_error",
    userActionable: false,
    message,
  };
}

/**
 * Common payload contract for outbound `send`. Connectors that honour this
 * shape can be invoked uniformly through the registry; connectors with
 * additional fields extend the type rather than redefine it.
 */
export interface ConnectorSendPayload {
  /** The recipient identity. Channel-specific format (chat id, phone, email). */
  target: string;
  /** Plain-text body to deliver. */
  message: string;
  /** Optional structured metadata forwarded to the underlying mixin. */
  metadata?: Record<string, unknown>;
}

export function isConnectorSendPayload(
  value: unknown,
): value is ConnectorSendPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.target === "string" && typeof v.message === "string";
}

export function rejectInvalidPayload(): DispatchResult {
  return {
    ok: false,
    reason: "transport_error",
    userActionable: false,
    message:
      "ConnectorContribution.send requires { target: string; message: string } payload.",
  };
}
