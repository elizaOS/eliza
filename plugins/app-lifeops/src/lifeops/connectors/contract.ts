/**
 * W1-F — Connector contract.
 *
 * Frozen interface per `docs/audit/wave1-interfaces.md` §3.1. The same shape is
 * called out in `docs/audit/GAP_ASSESSMENT.md` §3.1 / §3.17.
 *
 * Wave 1 ships the contract + an empty registry; Wave 2 (W2-B) populates the
 * 12 connector contributions.
 *
 * Capability strings are namespaced (e.g. `"google.calendar.read"`,
 * `"telegram.send"`, `"apple_health.read"`) so multiple connectors can advertise
 * overlapping capabilities and the runtime can resolve dispatchers without
 * pattern-matching on `kind`.
 */

export type ConnectorMode = "local" | "cloud";

export interface ConnectorStatus {
  state: "ok" | "degraded" | "disconnected";
  message?: string;
  observedAt: string;
}

/**
 * Typed dispatch result. Frozen per §3.17.
 *
 * Failure shapes carry enough information for the runner-side dispatch policy
 * (`./dispatch-policy.ts`) to choose between advance-escalation /
 * retry-with-backoff / fail-loud / queue-for-recovery without inspecting the
 * concrete error.
 *
 * Reason taxonomy:
 * - `disconnected` — connector currently has no live session (token revoked,
 *   socket closed, app uninstalled).
 * - `rate_limited` — transport refused due to per-window throttle. When set,
 *   `retryAfterMinutes` SHOULD also be populated.
 * - `auth_expired` — credentials valid but expired and the user must
 *   re-authorize. Always `userActionable: true`.
 * - `unknown_recipient` — the target identity does not resolve (e.g. wrong
 *   handle, blocked channel). Almost always permanent for that recipient.
 * - `transport_error` — generic infrastructure failure (network, 5xx, timeout).
 *   Connector decides whether to mark `userActionable`.
 */
export type DispatchResult =
  | { ok: true; messageId?: string }
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

export interface ConnectorContribution {
  /**
   * Stable connector key — `"google"`, `"telegram"`, `"discord"`,
   * `"apple_health"`, etc. Used as the registry lookup key.
   */
  kind: string;

  /**
   * Namespaced capability strings the connector advertises.
   *
   * Examples: `"google.calendar.read"`, `"google.gmail.draft.create"`,
   * `"telegram.send"`, `"apple_health.read"`, `"strava.read"`.
   */
  capabilities: string[];

  modes: ConnectorMode[];

  describe: { label: string };

  start(): Promise<void>;
  disconnect(): Promise<void>;
  verify(): Promise<boolean>;
  status(): Promise<ConnectorStatus>;

  /**
   * Optional outbound dispatch verb. The payload shape is connector-specific;
   * the registry does not validate it. Connectors that contribute send-capable
   * channels should also surface a {@link import("../channels/contract.js").ChannelContribution}.
   */
  send?(payload: unknown): Promise<DispatchResult>;

  /**
   * Optional read verb. The query and return shape are connector-specific.
   */
  read?(query: unknown): Promise<unknown>;

  /**
   * When `true`, the runtime gates this connector's outbound `send` calls
   * through the owner-send-policy (e.g. Gmail draft → owner approval). The
   * field is consumed by the W2-B runner integration; W1-F only declares it.
   */
  requiresApproval?: boolean;
}

export interface ConnectorRegistryFilter {
  capability?: string;
  mode?: ConnectorMode;
}

export interface ConnectorRegistry {
  register(c: ConnectorContribution): void;
  list(filter?: ConnectorRegistryFilter): ConnectorContribution[];
  get(kind: string): ConnectorContribution | null;
  byCapability(capability: string): ConnectorContribution[];
}
