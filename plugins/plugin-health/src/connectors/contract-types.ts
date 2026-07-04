/**
 * Canonical contract types for connector / channel / signal-bus consumers.
 *
 * Defines the frozen `ConnectorRegistry`, `AnchorRegistry`, and
 * `ActivitySignalBus` shapes. Reference: `docs/audit/wave1-interfaces.md` §3.
 *
 * No runtime behavior lives here — types only.
 */

export type ConnectorMode = "local" | "cloud";

export interface ConnectorStatus {
  state: "ok" | "degraded" | "disconnected";
  message?: string;
  observedAt: string;
}

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

/**
 * OAuth surface a connector contribution may advertise. URL provided by the
 * connector contribution; the dispatcher does not hardcode. Health-bridge
 * connectors (Strava, Fitbit, Withings, Oura) populate this so the OAuth
 * driver iterates the registry — see `health-bridge/health-provider-registry.ts`.
 */
export interface ConnectorOAuthConfig {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl?: string | null;
  readonly scopes?: readonly string[];
}

export interface ConnectorContribution {
  kind: string;
  capabilities: string[];
  modes: ConnectorMode[];
  describe: { label: string };
  /** URL provided by the connector contribution; the dispatcher does not hardcode. */
  oauth?: ConnectorOAuthConfig;
  /** URL provided by the connector contribution; the dispatcher does not hardcode. */
  apiBaseUrl?: string;
  start(): Promise<void>;
  disconnect(): Promise<void>;
  verify(): Promise<boolean>;
  status(): Promise<ConnectorStatus>;
  send?(payload: unknown): Promise<DispatchResult>;
  read?(query: unknown): Promise<unknown>;
  requiresApproval?: boolean;
}

export interface ConnectorRegistry {
  register(c: ConnectorContribution): void;
  list(filter?: {
    capability?: string;
    mode?: ConnectorMode;
  }): ConnectorContribution[];
  get(kind: string): ConnectorContribution | null;
  byCapability(capability: string): ConnectorContribution[];
}

/**
 * Registry surface exposed by the `ScheduledTask` runner for anchor key
 * registration. plugin-health contributes `wake.observed`, `wake.confirmed`,
 * `bedtime.target`, `nap.start` (see `docs/audit/wave1-interfaces.md` §5.2).
 *
 * `wake.observed` and `wake.confirmed` are intentionally separate:
 * `observed` = first signal that fits a wake pattern; `confirmed` = sustained
 * signal that survives the `WAKE_CONFIRM_WINDOW_MS` hysteresis window in
 * `circadian-rules.ts`.
 */
export interface AnchorRegistry {
  register(anchor: AnchorContribution): void;
  list(): AnchorContribution[];
  get(anchorKey: string): AnchorContribution | null;
}

export interface AnchorContribution {
  anchorKey: string;
  description: string;
  source: "plugin-health" | string;
  describe?: { label: string; provider: string };
  resolve?(
    context: unknown,
  ): { atIso: string } | null | Promise<{ atIso: string } | null>;
}

/**
 * Bus-family registry for `ActivitySignalBus`. plugin-health publishes the
 * health-prefixed families documented in `docs/audit/wave1-interfaces.md` §5.3.
 */
export interface BusFamilyRegistry {
  register(family: BusFamilyContribution): void;
  list(): BusFamilyContribution[];
}

/** A single signal envelope as read back from the `ActivitySignalBus`. */
export interface ActivitySignalRecord {
  family: string;
  occurredAt: string;
  payload?: unknown;
}

/**
 * Read-side view of the host's `ActivitySignalBus` — the minimum surface the
 * observed-anchor resolvers need ("which transitions of family X happened
 * since Y?"). Structural on purpose: the concrete bus lives in
 * `@elizaos/plugin-personal-assistant` (`lifeops/signals/bus.ts`), which
 * plugin-health must not import (the dependency points the other way). The
 * host exposes its bus on the runtime as `activitySignalBus`.
 */
export interface ActivitySignalReader {
  recent(args: { sinceIso: string; family?: string }): ActivitySignalRecord[];
}

export interface BusFamilyContribution {
  family: string;
  description: string;
  source: "plugin-health" | string;
}

/**
 * The runtime surface plugin-health expects to find on `IAgentRuntime`. All
 * registries are optional; registration callers tolerate a missing registry
 * by logging a one-line skip reason.
 */
export interface RuntimeWithHealthRegistries {
  connectorRegistry?: ConnectorRegistry;
  anchorRegistry?: AnchorRegistry;
  busFamilyRegistry?: BusFamilyRegistry;
  /**
   * Read-side of the host's `ActivitySignalBus`. The observed-anchor
   * resolvers registered by `registerHealthAnchors` read wake/sleep/nap
   * transition envelopes through this seam; when absent, every anchor
   * resolves `null` and `relative_to_anchor` falls back to the static
   * owner-window defaults in the scheduling spine.
   */
  activitySignalBus?: ActivitySignalReader;
}
