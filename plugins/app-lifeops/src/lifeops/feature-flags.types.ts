/**
 * LifeOps feature opt-in framework — closed enums + typed envelope.
 *
 * Source of truth (Commandment 7):
 *  - The literal union `LifeOpsFeatureKey` enumerates every gateable
 *    capability.
 *  - `BASE_FEATURE_DEFAULTS` declares the compile-time baseline. The DB
 *    table only stores *overrides* — never used to discover new keys.
 *  - The actions/services that gate on these keys must throw
 *    `FeatureNotEnabledError` before they touch the network or spend
 *    money. Silent fallbacks are not allowed (Commandment 8).
 *
 * Source rules:
 *  - `default` — the row is absent in the DB; `enabled` reflects the
 *    resolved compile-time default for the current Cloud-link context.
 *    The runtime never *writes* a `default` row.
 *  - `local`   — toggled from the desktop UI / chat command.
 *  - `cloud`   — auto-provisioned by an Eliza Cloud package sync.
 *
 * Cloud rows are read-only from the local UI: a Cloud-managed enable
 * cannot be revoked locally, only by removing the Cloud package.
 *
 * Cloud-default policy:
 *  - When the user is signed into Eliza Cloud, travel features and the
 *    cloud-managed travel-billing flag flip ON by default. Cost is
 *    metered Cloud-side; the local code never recomputes that markup
 *    (Commandment 2).
 *  - Without Cloud, paid features stay OFF until the user opts in
 *    locally (which then requires them to bring their own travel-provider
 *    API credentials via `ELIZA_DUFFEL_DIRECT=1` + `DUFFEL_API_KEY`).
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

/**
 * Open-key sibling of `LifeOpsFeatureKey`. The closed union remains the
 * compile-time authority for the built-in 10 flags (Cloud-default policy,
 * `BASE_FEATURE_DEFAULTS`, typed gate calls). The runtime
 * `FeatureFlagRegistry` is the source of truth for what flags exist —
 * including 3rd-party plugin contributions — so anywhere that ingests a
 * key from outside (chat input, REST routes, dev-registries view) uses
 * `LifeOpsFeatureFlagKey`. Parallel to W2-D's
 * `LifeOpsBusFamily = LifeOpsTelemetryFamily | string`.
 */
export type LifeOpsFeatureFlagKey = LifeOpsFeatureKey | string;

export type FeatureFlagSource = "default" | "local" | "cloud";

export interface FeatureFlagDefault {
  /** Compile-time baseline — applies until a row overrides it. May be
   *  flipped by `resolveFeatureDefaults` based on Cloud-link state. */
  readonly enabled: boolean;
  /** Short user-facing label shown in settings and confirmations. */
  readonly label: string;
  /** One-line user-facing description shown in the settings UI. */
  readonly description: string;
  /**
   * True when toggling the feature on commits the user to recurring spend
   * or external billing (e.g. live flight booking, paid SMS). Surfaced in
   * the UI so the user understands the implication.
   */
  readonly costsMoney: boolean;
}

/**
 * Compile-time baseline. Conservative — assumes no Cloud account.
 *
 * `resolveFeatureDefaults({cloudLinked})` is the only function callers
 * should use to read effective defaults. Direct reads of this constant
 * skip the Cloud-aware policy and will under-report enablement for
 * Cloud-linked users.
 */
export const BASE_FEATURE_DEFAULTS: Readonly<
  Record<LifeOpsFeatureKey, FeatureFlagDefault>
> = {
  "travel.search_flight": {
    enabled: true,
    label: "Search flights",
    description:
      "Search flight inventory through the configured travel provider (read-only). Required for itinerary planning.",
    costsMoney: false,
  },
  "travel.search_hotel": {
    enabled: true,
    label: "Search hotels",
    description:
      "Search hotel inventory through the configured travel provider (read-only). Required for trip planning.",
    costsMoney: false,
  },
  "travel.book_flight": {
    enabled: false,
    label: "Book flights",
    description:
      "Place real flight bookings through the configured travel provider. Each booking still requires explicit approval.",
    costsMoney: true,
  },
  "travel.book_hotel": {
    enabled: false,
    label: "Book hotels",
    description:
      "Place real hotel bookings through the configured travel provider. Each booking still requires explicit approval.",
    costsMoney: true,
  },
  "notifications.push": {
    enabled: false,
    label: "Push notifications",
    description:
      "Send push notifications via Ntfy. Requires NTFY_BASE_URL configuration.",
    costsMoney: false,
  },
  "cross_channel.escalate": {
    enabled: false,
    label: "Cross-channel escalation",
    description:
      "Escalate unanswered messages across channels (e.g. Telegram → SMS → call).",
    costsMoney: true,
  },
  "browser.automation": {
    enabled: false,
    label: "Browser automation",
    description:
      "Allow Eliza to drive the browser extension (form fills, navigation, clicks).",
    costsMoney: false,
  },
  "email.draft": {
    enabled: true,
    label: "Draft emails",
    description: "Draft email replies in your inbox without sending them.",
    costsMoney: false,
  },
  "email.send": {
    enabled: false,
    label: "Send emails",
    description:
      "Send drafted emails on your behalf (still gated by approval queue).",
    costsMoney: false,
  },
  "cloud.duffel": {
    enabled: false,
    label: "Cloud travel billing",
    description:
      "Use Eliza Cloud's managed travel-provider billing instead of bringing your own provider API credentials.",
    costsMoney: true,
  },
};

/**
 * Feature keys that default to ON when the user is signed into Eliza
 * Cloud. Service fees are applied Cloud-side (Commandment 2/4 — no client
 * math), so flipping these on locally is purely a default-policy decision:
 * it does not change billing.
 */
export const CLOUD_LINKED_DEFAULT_ON: ReadonlySet<LifeOpsFeatureKey> = new Set([
  "travel.search_flight",
  "travel.search_hotel",
  "travel.book_flight",
  "travel.book_hotel",
  "cloud.duffel",
]);

export function isCloudLinkedDefaultOnFeatureKey(
  key: LifeOpsFeatureKey,
): boolean {
  return CLOUD_LINKED_DEFAULT_ON.has(key);
}

export interface ResolveFeatureDefaultsArgs {
  readonly cloudLinked: boolean;
}

/**
 * Resolve effective compile-time defaults for the given Cloud-link state.
 *
 *  - `cloudLinked: true`  → travel + `cloud.duffel` ON, billed via
 *    Eliza Cloud's managed travel-provider billing.
 *  - `cloudLinked: false` → baseline (paid features OFF) until the user
 *    opts in locally and supplies their own travel-provider credentials.
 */
export function resolveFeatureDefaults(
  args: ResolveFeatureDefaultsArgs,
): Readonly<Record<LifeOpsFeatureKey, FeatureFlagDefault>> {
  if (!args.cloudLinked) {
    return BASE_FEATURE_DEFAULTS;
  }
  const resolved: Record<LifeOpsFeatureKey, FeatureFlagDefault> = {
    ...BASE_FEATURE_DEFAULTS,
  };
  for (const key of CLOUD_LINKED_DEFAULT_ON) {
    const base = BASE_FEATURE_DEFAULTS[key];
    if (base.enabled) continue;
    resolved[key] = { ...base, enabled: true };
  }
  return resolved;
}

export const ALL_FEATURE_KEYS: ReadonlyArray<LifeOpsFeatureKey> = Object.keys(
  BASE_FEATURE_DEFAULTS,
) as LifeOpsFeatureKey[];

export function isLifeOpsFeatureKey(
  value: unknown,
): value is LifeOpsFeatureKey {
  return typeof value === "string" && value in BASE_FEATURE_DEFAULTS;
}

export interface FeatureFlagState {
  readonly featureKey: LifeOpsFeatureFlagKey;
  readonly enabled: boolean;
  readonly source: FeatureFlagSource;
  readonly enabledAt: Date | null;
  readonly enabledBy: string | null;
  readonly label: string;
  readonly description: string;
  readonly costsMoney: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface LifeOpsFeatureFlagRowDto {
  readonly featureKey: LifeOpsFeatureFlagKey;
  readonly enabled: boolean;
  readonly source: FeatureFlagSource;
  readonly label: string;
  readonly description: string;
  readonly costsMoney: boolean;
  readonly enabledAt: string | null;
  readonly enabledBy: string | null;
  readonly packageId: string | null;
  readonly cloudDefaultOn: boolean;
}

export interface LifeOpsFeatureFlagsResponse {
  readonly features: ReadonlyArray<LifeOpsFeatureFlagRowDto>;
}

export interface LifeOpsFeatureFlagsSyncResponse
  extends LifeOpsFeatureFlagsResponse {
  readonly synced: number;
}

export interface LifeOpsFeatureToggleResponse {
  readonly feature: LifeOpsFeatureFlagRowDto;
}

export interface FeatureToggleRequest {
  readonly featureKey: LifeOpsFeatureFlagKey;
  readonly enabled: boolean;
  readonly source: FeatureFlagSource;
  readonly enabledBy: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type FeatureFlagChangeListener = (state: FeatureFlagState) => void;

export interface FeatureFlagService {
  isEnabled(key: LifeOpsFeatureFlagKey): Promise<boolean>;
  get(key: LifeOpsFeatureFlagKey): Promise<FeatureFlagState>;
  list(): Promise<ReadonlyArray<FeatureFlagState>>;
  enable(
    key: LifeOpsFeatureFlagKey,
    source: FeatureFlagSource,
    enabledBy: string | null,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<FeatureFlagState>;
  disable(
    key: LifeOpsFeatureFlagKey,
    source: FeatureFlagSource,
    enabledBy: string | null,
  ): Promise<FeatureFlagState>;
  subscribeChanges(handler: FeatureFlagChangeListener): () => void;
}

/**
 * Thrown by gated actions before they perform any side effect when the
 * required feature key is disabled. Carries enough context for the LLM
 * planner to surface a useful "enable this" message back to the owner —
 * including a Cloud-aware suggestion when the user is not signed in.
 */
export class FeatureNotEnabledError extends Error {
  readonly code = "FEATURE_NOT_ENABLED" as const;
  readonly featureKey: LifeOpsFeatureFlagKey;
  readonly cloudOptIn: boolean;
  readonly cloudLinked: boolean;

  constructor(
    featureKey: LifeOpsFeatureFlagKey,
    args?: { cloudLinked?: boolean; message?: string; costsMoney?: boolean },
  ) {
    // Built-in: pull `costsMoney` from `BASE_FEATURE_DEFAULTS`. Otherwise the
    // caller supplies it from the registry contribution metadata so the
    // Cloud opt-in suggestion stays accurate for 3rd-party flags.
    const builtinCostsMoney = isLifeOpsFeatureKey(featureKey)
      ? BASE_FEATURE_DEFAULTS[featureKey].costsMoney
      : null;
    const cloudOptIn = builtinCostsMoney ?? args?.costsMoney ?? false;
    const cloudLinked = args?.cloudLinked === true;
    const text =
      args?.message ??
      buildFeatureDisabledMessage(featureKey, { cloudOptIn, cloudLinked });
    super(text);
    this.name = "FeatureNotEnabledError";
    this.featureKey = featureKey;
    this.cloudOptIn = cloudOptIn;
    this.cloudLinked = cloudLinked;
  }
}

function buildFeatureDisabledMessage(
  featureKey: LifeOpsFeatureFlagKey,
  args: { cloudOptIn: boolean; cloudLinked: boolean },
): string {
  const base = `Feature '${featureKey}' is off.`;
  if (!args.cloudOptIn) {
    return `${base} Enable it via Settings → Features.`;
  }
  if (!args.cloudLinked) {
    return `${base} The simplest path is to sign in to Eliza Cloud so managed travel billing turns on automatically. Or enable it locally via Settings → Features (requires your own travel-provider API credentials).`;
  }
  return `${base} Enable it via Settings → Features or sign up for the matching Eliza Cloud package.`;
}
