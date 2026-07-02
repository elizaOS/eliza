/**
 * Internal helpers for connector wrappers.
 *
 * Provides translation from service-mixin bespoke status shapes into the
 * canonical contract:
 *
 *   - {@link ConnectorStatus} — uniform `ok | degraded | disconnected` triple.
 *   - {@link DispatchResult}  — typed success / failure for `send`.
 */
import { formatError, LifeOpsServiceError } from "@elizaos/shared";
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
  return {
    ok: false,
    reason: "transport_error",
    userActionable: false,
    message: safeFormatError(error),
  };
}

/**
 * Crash-safe wrapper around {@link formatError}. A dispatch failure must never
 * itself throw while being turned into a `DispatchResult` — the runner would
 * then strand the fire instead of recording a typed transport error. But
 * `formatError` coerces non-Error values with `String(value)`, which throws
 * on a hostile rejection value: a null-prototype object (no `toString` on the
 * chain), or an object whose `toString` / `Symbol.toPrimitive` throws. Fall
 * back to `Object.prototype.toString.call`, which reports the type tag
 * (`"[object Object]"`) without invoking any of the object's own coercion
 * hooks.
 */
function safeFormatError(error: unknown): string {
  try {
    return formatError(error);
  } catch {
    try {
      return Object.prototype.toString.call(error);
    } catch {
      return "[object Object]";
    }
  }
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

/**
 * Type guard for the outbound `send` payload. Rejects any value that is not a
 * `{ target: string; message: string }` object. `target` must be a non-empty,
 * non-whitespace string: an empty or whitespace-only recipient is never a valid
 * identity, and letting it through would hand an unroutable send to transport.
 */
export function isConnectorSendPayload(
  value: unknown,
): value is ConnectorSendPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.target === "string" &&
    v.target.trim().length > 0 &&
    typeof v.message === "string"
  );
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
