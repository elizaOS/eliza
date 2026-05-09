/**
 * Wave-1 stubs for the W1-F connector / channel / signal-bus contracts.
 *
 * These mirror `wave1-interfaces.md` §3 byte-identically. When W1-F lands the
 * concrete `ConnectorRegistry` / `AnchorRegistry` / `ActivitySignalBus` types
 * in their owning module, every `import` from this file should be replaced
 * with the real path; nothing else needs to change because the shapes here
 * are the frozen contract.
 *
 * No runtime behaviour lives here — types only.
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

export interface ConnectorContribution {
  kind: string;
  capabilities: string[];
  modes: ConnectorMode[];
  describe: { label: string };
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
 * Registry surface exposed by W1-A's `ScheduledTask` runner for anchor key
 * registration. plugin-health contributes `wake.observed`, `wake.confirmed`,
 * `bedtime.target`, `nap.start` per `wave1-interfaces.md` §5.2.
 *
 * `wake.observed` and `wake.confirmed` are intentionally separate (per
 * `IMPLEMENTATION_PLAN.md` §3.2): `observed` = first signal that fits a wake
 * pattern, `confirmed` = sustained signal that survives the
 * `WAKE_CONFIRM_WINDOW_MS` hysteresis window in `circadian-rules.ts`.
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
}

/**
 * Bus-family registry for `ActivitySignalBus`. plugin-health publishes the
 * health-prefixed families documented in `wave1-interfaces.md` §5.3.
 */
export interface BusFamilyRegistry {
  register(family: BusFamilyContribution): void;
  list(): BusFamilyContribution[];
}

export interface BusFamilyContribution {
  family: string;
  description: string;
  source: "plugin-health" | string;
}

/**
 * The runtime surface plugin-health expects to find on `IAgentRuntime`. All
 * four registries are optional (`undefined` when W1-A / W1-F have not landed
 * yet); registration callers tolerate a missing registry by logging a one-
 * line skip reason.
 */
export interface RuntimeWithHealthRegistries {
  connectorRegistry?: ConnectorRegistry;
  anchorRegistry?: AnchorRegistry;
  busFamilyRegistry?: BusFamilyRegistry;
}
