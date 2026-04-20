/**
 * LifeOps feature opt-in framework — closed enums + typed envelope.
 *
 * Source of truth (Commandment 7):
 *  - The literal union `LifeOpsFeatureKey` enumerates every gateable
 *    capability.
 *  - `FEATURE_DEFAULTS` declares the compile-time default state. The DB
 *    table only stores *overrides* — never used to discover new keys.
 *  - The actions/services that gate on these keys must throw
 *    `FeatureNotEnabledError` before they touch the network or spend
 *    money. Silent fallbacks are not allowed (Commandment 8).
 *
 * Source rules:
 *  - `default` — the row is absent in the DB; `enabled` reflects
 *    `FEATURE_DEFAULTS`. The runtime never *writes* a `default` row.
 *  - `local`   — toggled from the desktop UI / chat command.
 *  - `cloud`   — auto-provisioned by an Eliza Cloud package sync.
 *
 * Cloud rows are read-only from the local UI: a Cloud-managed enable
 * cannot be revoked locally, only by removing the Cloud package.
 */

export type LifeOpsFeatureKey =
  | "travel.search_flight"
  | "travel.search_hotel"
  | "travel.book_flight"
  | "travel.book_hotel"
  | "notifications.push"
  | "cross_channel.escalate"
  | "browser.automation"
  | "email.draft"
  | "email.send"
  | "cloud.duffel";

export type FeatureFlagSource = "default" | "local" | "cloud";

export interface FeatureFlagDefault {
  /** Compile-time default — applies until a row overrides it. */
  readonly enabled: boolean;
  /** One-line user-facing description shown in the settings UI. */
  readonly description: string;
  /**
   * True when toggling the feature on commits the user to recurring spend
   * or external billing (e.g. live flight booking, paid SMS). Surfaced in
   * the UI so the user understands the implication.
   */
  readonly costsMoney: boolean;
}

export const FEATURE_DEFAULTS: Readonly<
  Record<LifeOpsFeatureKey, FeatureFlagDefault>
> = {
  "travel.search_flight": {
    enabled: true,
    description:
      "Search Duffel flight inventory (read-only). Required for itinerary planning.",
    costsMoney: false,
  },
  "travel.search_hotel": {
    enabled: true,
    description:
      "Search Duffel Stays hotel inventory (read-only). Required for trip planning.",
    costsMoney: false,
  },
  "travel.book_flight": {
    enabled: false,
    description:
      "Place real flight bookings via Duffel. Each booking still requires explicit approval.",
    costsMoney: true,
  },
  "travel.book_hotel": {
    enabled: false,
    description:
      "Place real hotel bookings via Duffel Stays. Each booking still requires explicit approval.",
    costsMoney: true,
  },
  "notifications.push": {
    enabled: false,
    description:
      "Send push notifications via Ntfy. Requires NTFY_BASE_URL configuration.",
    costsMoney: false,
  },
  "cross_channel.escalate": {
    enabled: false,
    description:
      "Escalate unanswered messages across channels (e.g. Telegram → SMS → call).",
    costsMoney: true,
  },
  "browser.automation": {
    enabled: false,
    description:
      "Allow Eliza to drive the browser extension (form fills, navigation, clicks).",
    costsMoney: false,
  },
  "email.draft": {
    enabled: true,
    description: "Draft email replies in your inbox without sending them.",
    costsMoney: false,
  },
  "email.send": {
    enabled: false,
    description:
      "Send drafted emails on your behalf (still gated by approval queue).",
    costsMoney: false,
  },
  "cloud.duffel": {
    enabled: false,
    description:
      "Use Eliza Cloud's managed Duffel billing instead of bringing your own DUFFEL_API_KEY.",
    costsMoney: true,
  },
};

export const ALL_FEATURE_KEYS: ReadonlyArray<LifeOpsFeatureKey> = Object.keys(
  FEATURE_DEFAULTS,
) as LifeOpsFeatureKey[];

export function isLifeOpsFeatureKey(value: unknown): value is LifeOpsFeatureKey {
  return typeof value === "string" && value in FEATURE_DEFAULTS;
}

export interface FeatureFlagState {
  readonly featureKey: LifeOpsFeatureKey;
  readonly enabled: boolean;
  readonly source: FeatureFlagSource;
  readonly enabledAt: Date | null;
  readonly enabledBy: string | null;
  readonly description: string;
  readonly costsMoney: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface FeatureToggleRequest {
  readonly featureKey: LifeOpsFeatureKey;
  readonly enabled: boolean;
  readonly source: FeatureFlagSource;
  readonly enabledBy: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type FeatureFlagChangeListener = (state: FeatureFlagState) => void;

export interface FeatureFlagService {
  isEnabled(key: LifeOpsFeatureKey): Promise<boolean>;
  get(key: LifeOpsFeatureKey): Promise<FeatureFlagState>;
  list(): Promise<ReadonlyArray<FeatureFlagState>>;
  enable(
    key: LifeOpsFeatureKey,
    source: FeatureFlagSource,
    enabledBy: string | null,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<FeatureFlagState>;
  disable(
    key: LifeOpsFeatureKey,
    source: FeatureFlagSource,
    enabledBy: string | null,
  ): Promise<FeatureFlagState>;
  subscribeChanges(handler: FeatureFlagChangeListener): () => void;
}

/**
 * Thrown by gated actions before they perform any side effect when the
 * required feature key is disabled. Carries enough context for the LLM
 * planner to surface a useful "enable this in Settings" message back to
 * the owner.
 */
export class FeatureNotEnabledError extends Error {
  readonly code = "FEATURE_NOT_ENABLED" as const;
  readonly featureKey: LifeOpsFeatureKey;
  readonly cloudOptIn: boolean;

  constructor(featureKey: LifeOpsFeatureKey, message?: string) {
    const def = FEATURE_DEFAULTS[featureKey];
    const cloudOptIn = def.costsMoney;
    const text =
      message ??
      `Feature '${featureKey}' is off. Enable it via Settings → Features` +
        (cloudOptIn
          ? ` or sign up for the matching Eliza Cloud package.`
          : `.`);
    super(text);
    this.name = "FeatureNotEnabledError";
    this.featureKey = featureKey;
    this.cloudOptIn = cloudOptIn;
  }
}
