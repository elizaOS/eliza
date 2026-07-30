/**
 * Internal helpers for connector wrappers.
 *
 * Provides translation from service-mixin bespoke status shapes into the
 * canonical contract:
 *
 *   - {@link ConnectorStatus} — uniform `ok | degraded | disconnected` triple.
 *   - {@link DispatchResult}  — typed success / failure for `send`.
 */

import type { DispatchReceipt } from "@elizaos/plugin-scheduling";
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
          acceptance: "not_accepted",
          userActionable: true,
          message,
        };
      case 403:
        return {
          ok: false,
          reason: "auth_expired",
          acceptance: "not_accepted",
          userActionable: true,
          message,
        };
      case 404:
        return {
          ok: false,
          reason: "unknown_recipient",
          acceptance: "not_accepted",
          userActionable: true,
          message,
        };
      case 409:
        return {
          ok: false,
          reason: "disconnected",
          acceptance: "not_accepted",
          userActionable: true,
          message,
        };
      case 429:
        return {
          ok: false,
          reason: "rate_limited",
          acceptance: "not_accepted",
          retryAfterMinutes: 5,
          userActionable: false,
          message,
        };
      case 503:
        return {
          ok: false,
          reason: "disconnected",
          acceptance: "not_accepted",
          userActionable: true,
          message,
        };
      default:
        return {
          ok: false,
          reason: "transport_error",
          acceptance: "unknown",
          userActionable: false,
          message,
        };
    }
  }
  return {
    ok: false,
    reason: "transport_error",
    acceptance: "unknown",
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
export function safeFormatError(error: unknown): string {
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
  /**
   * How `target` addresses the transport when the platform distinguishes user
   * identities from conversation ids. `"user"` means `target` is a platform
   * user id the connector must resolve to a direct conversation itself
   * (Discord: `users.fetch` → `createDM`); `"channel"`/omitted means `target`
   * is a conversation/channel id usable as-is. Discord is the only transport
   * where the two id spaces differ, and treating a user id as a channel id
   * fails with Unknown Channel — senders addressing a person must say so.
   */
  targetKind?: "user" | "channel";
  /** Plain-text body to deliver. */
  message: string;
  /**
   * Stable logical-send key supplied by the durable approval executor.
   * Connectors echo it in a provider receipt; transports with native
   * idempotency should also forward it to that API.
   */
  idempotencyKey?: string;
  /** Optional structured metadata forwarded to the underlying mixin. */
  metadata?: Record<string, unknown>;
}

export function dispatchReceipt(args: {
  provider: string;
  providerMessageId: string | null | undefined;
  payload: ConnectorSendPayload;
  metadata?: Record<string, unknown>;
}): DispatchReceipt | null {
  const provider = args.provider.trim();
  const providerMessageId = args.providerMessageId?.trim() ?? "";
  const idempotencyKey = args.payload.idempotencyKey?.trim() ?? "";
  if (!provider || !providerMessageId || !idempotencyKey) {
    return null;
  }
  return {
    provider,
    providerMessageId,
    idempotencyKey,
    acceptedAt: new Date().toISOString(),
    ...(args.metadata ? { metadata: args.metadata } : {}),
  };
}

/** A provider reported success without the identifier needed to prove it. */
export function missingProviderReceipt(
  provider: string,
): Extract<DispatchResult, { ok: false }> {
  return {
    ok: false,
    reason: "transport_error",
    acceptance: "unknown",
    userActionable: false,
    message: `${provider} accepted the send path without returning a durable provider receipt.`,
  };
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
    typeof v.message === "string" &&
    (v.targetKind === undefined ||
      v.targetKind === "user" ||
      v.targetKind === "channel")
  );
}

export function rejectInvalidPayload(): DispatchResult {
  return {
    ok: false,
    reason: "transport_error",
    acceptance: "not_accepted",
    userActionable: false,
    message:
      "ConnectorContribution.send requires { target: string; message: string } payload.",
  };
}
