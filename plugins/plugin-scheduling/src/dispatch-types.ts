/**
 * Dispatch result contract for the scheduling spine.
 *
 * The runner is storage- and transport-agnostic: it only needs the *shape* of a
 * dispatch outcome to drive its dispatch policy (advance-escalation /
 * retry-with-backoff / fail-loud / queue-for-recovery) without inspecting the
 * concrete error. The connector layer that actually sends (owned by the host,
 * e.g. `@elizaos/plugin-personal-assistant`) produces values of this type.
 *
 * Reason taxonomy:
 * - `disconnected` — connector currently has no live session.
 * - `rate_limited` — transport refused due to per-window throttle; SHOULD also
 *   populate `retryAfterMinutes`.
 * - `auth_expired` — credentials expired; the user must re-authorize.
 * - `unknown_recipient` — the target identity does not resolve.
 * - `transport_error` — generic infrastructure failure (network, 5xx, timeout).
 */
/**
 * Provider-issued evidence that an outbound message was accepted. A caller
 * may persist this as a mutation receipt only when every field is present;
 * `ok: true` by itself is transport success, not proof of a durable side
 * effect.
 */
export interface DispatchReceipt {
  readonly provider: string;
  readonly providerMessageId: string;
  readonly idempotencyKey: string;
  readonly acceptedAt: string;
  readonly metadata?: Record<string, unknown>;
}

export type DispatchResult =
  | {
      ok: true;
      messageId?: string;
      target?: string;
      channelKey?: string;
      metadata?: Record<string, unknown>;
      receipt?: DispatchReceipt;
    }
  | {
      ok: false;
      reason:
        | "disconnected"
        | "rate_limited"
        | "auth_expired"
        | "unknown_recipient"
        | "transport_error";
      retryAfterMinutes?: number;
      userActionable: boolean;
      message?: string;
      /**
       * Whether the provider definitively rejected the request before
       * acceptance. Missing means unknown; unknown failures must never be
       * automatically retried for a non-idempotent transport.
       */
      acceptance?: "not_accepted" | "unknown";
    };
