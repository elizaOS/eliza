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
export type DispatchResult =
  | { ok: true; messageId?: string; target?: string; channelKey?: string }
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
    };
