/**
 * Health-connector provider registry.
 *
 * Audit C top-3 (medium severity) — `rigidity-hunt-audit.md` §3:
 * Strava / Fitbit / Withings / Oura URLs used to live in per-provider
 * `switch (provider) { case "strava": ... }` arms inside `health-oauth.ts`
 * and `health-connectors.ts`. Adding a fifth provider required editing both
 * files. This registry centralises every per-provider URL + token-exchange
 * shape so the dispatchers iterate a single typed table.
 *
 * The OAuth + base URLs are also surfaced on the connector contributions
 * registered through `connectors/index.ts` (`ConnectorContribution.oauth`,
 * `ConnectorContribution.apiBaseUrl`). External plugins that contribute
 * additional health connectors register their spec via
 * `setHealthProviderSpec(...)` instead of patching this module.
 */

import type {
  LifeOpsHealthConnectorCapability,
  LifeOpsHealthConnectorProvider,
} from "../contracts/health.js";

/**
 * OAuth surface for one health provider. Every URL / scope-shape the OAuth
 * dispatcher needs lives here; `health-oauth.ts` does not hardcode any
 * provider-specific URLs.
 */
export interface HealthProviderOAuthSpec {
  /** OAuth 2.0 authorize endpoint. URL provided by the connector contribution; the dispatcher does not hardcode. */
  readonly authorizeUrl: string;
  /** OAuth 2.0 token endpoint. URL provided by the connector contribution; the dispatcher does not hardcode. */
  readonly tokenUrl: string;
  /** Optional OAuth 2.0 token-revocation endpoint. */
  readonly revokeUrl: string | null;
  /** Default scope set requested at authorize time. */
  readonly defaultScopes: readonly string[];
  /** Scope-list separator on the authorize URL: `space` or `comma`. */
  readonly scopeSeparator: "space" | "comma";
  /** Whether to attach PKCE (S256) on the authorize + token requests. */
  readonly usePkce: boolean;
  /**
   * Token-request body/auth shape:
   *   - `form` — credentials in the form body (Strava, Withings).
   *   - `basic` — credentials in the `Authorization: Basic` header (Fitbit,
   *     Oura).
   *   - `withings` — `form` plus the Withings-specific `action=requesttoken`
   *     marker.
   */
  readonly tokenRequestStyle: "form" | "basic" | "withings";
  /**
   * Provider-specific extra query parameters appended to the authorize URL
   * (e.g. Strava's `approval_prompt=auto`). Externalising these keeps every
   * provider quirk inside the registry and out of dispatcher branches.
   */
  readonly extraAuthorizeParams?: Readonly<Record<string, string>>;
}

/**
 * Full provider record. Combines OAuth, API base URL, and capability mapping
 * so the dispatchers can resolve every per-provider value in one lookup.
 */
export interface HealthProviderSpec {
  readonly provider: string;
  /** Env-var prefix for `ELIZA_<PREFIX>_CLIENT_ID` etc. */
  readonly envPrefix: string;
  readonly oauth: HealthProviderOAuthSpec;
  /** Base URL for authenticated API requests. URL provided by the connector contribution; the dispatcher does not hardcode. */
  readonly apiBaseUrl: string;
  /** Capabilities advertised by the connector when fully authorised. */
  readonly capabilities: readonly LifeOpsHealthConnectorCapability[];
}

/**
 * Thrown when a caller asks for OAuth-related operations on a provider whose
 * registered spec does not include an `oauth` block. Surfaces loudly rather
 * than falling back to a default endpoint.
 */
export class MissingOauthConfigError extends Error {
  public readonly provider: string;
  constructor(provider: string) {
    super(
      `Health connector '${provider}' has no registered OAuth config; refusing to proceed.`,
    );
    this.name = "MissingOauthConfigError";
    this.provider = provider;
  }
}

const DEFAULT_HEALTH_PROVIDER_SPECS: Record<
  LifeOpsHealthConnectorProvider,
  HealthProviderSpec
> = {
  strava: {
    provider: "strava",
    envPrefix: "STRAVA",
    oauth: {
      authorizeUrl: "https://www.strava.com/oauth/authorize",
      tokenUrl: "https://www.strava.com/oauth/token",
      revokeUrl: "https://www.strava.com/oauth/deauthorize",
      defaultScopes: ["read", "profile:read_all", "activity:read_all"],
      scopeSeparator: "comma",
      usePkce: false,
      tokenRequestStyle: "form",
      extraAuthorizeParams: { approval_prompt: "auto" },
    },
    apiBaseUrl: "https://www.strava.com/api/v3",
    capabilities: ["health.activity.read", "health.workouts.read"],
  },
  fitbit: {
    provider: "fitbit",
    envPrefix: "FITBIT",
    oauth: {
      authorizeUrl: "https://www.fitbit.com/oauth2/authorize",
      tokenUrl: "https://api.fitbit.com/oauth2/token",
      revokeUrl: "https://api.fitbit.com/oauth2/revoke",
      defaultScopes: ["profile", "activity", "heartrate", "sleep", "weight"],
      scopeSeparator: "space",
      usePkce: true,
      tokenRequestStyle: "basic",
    },
    apiBaseUrl: "https://api.fitbit.com",
    capabilities: [
      "health.activity.read",
      "health.workouts.read",
      "health.sleep.read",
      "health.body.read",
      "health.vitals.read",
    ],
  },
  withings: {
    provider: "withings",
    envPrefix: "WITHINGS",
    oauth: {
      authorizeUrl: "https://account.withings.com/oauth2_user/authorize2",
      tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
      revokeUrl: null,
      defaultScopes: [
        "user.info",
        "user.metrics",
        "user.activity",
        "user.sleepevents",
      ],
      scopeSeparator: "comma",
      usePkce: false,
      tokenRequestStyle: "withings",
    },
    apiBaseUrl: "https://wbsapi.withings.net",
    capabilities: [
      "health.activity.read",
      "health.sleep.read",
      "health.body.read",
      "health.vitals.read",
    ],
  },
  oura: {
    provider: "oura",
    envPrefix: "OURA",
    oauth: {
      authorizeUrl: "https://cloud.ouraring.com/oauth/authorize",
      tokenUrl: "https://api.ouraring.com/oauth/token",
      revokeUrl: "https://api.ouraring.com/oauth/revoke",
      defaultScopes: [
        "email",
        "personal",
        "daily",
        "heartrate",
        "workout",
        "spo2",
      ],
      scopeSeparator: "space",
      usePkce: false,
      tokenRequestStyle: "basic",
    },
    apiBaseUrl: "https://api.ouraring.com",
    capabilities: [
      "health.activity.read",
      "health.workouts.read",
      "health.sleep.read",
      "health.readiness.read",
      "health.body.read",
      "health.vitals.read",
    ],
  },
};

const healthProviderSpecs: Map<string, HealthProviderSpec> = new Map(
  Object.entries(DEFAULT_HEALTH_PROVIDER_SPECS),
);

export function listHealthProviderSpecs(): HealthProviderSpec[] {
  return Array.from(healthProviderSpecs.values());
}

export function getHealthProviderSpec(
  provider: string,
): HealthProviderSpec | null {
  return healthProviderSpecs.get(provider) ?? null;
}

/**
 * Look up a provider spec, throwing if it is not registered. The dispatcher
 * uses this in places where a missing entry indicates a programming error.
 */
export function requireHealthProviderSpec(
  provider: string,
): HealthProviderSpec {
  const spec = healthProviderSpecs.get(provider);
  if (!spec) {
    throw new MissingOauthConfigError(provider);
  }
  return spec;
}

/**
 * Register or replace a provider spec. Used by tests and out-of-tree plugins
 * to add a fifth provider without editing this module.
 */
export function setHealthProviderSpec(spec: HealthProviderSpec): void {
  healthProviderSpecs.set(spec.provider, spec);
}

export function deleteHealthProviderSpec(provider: string): void {
  healthProviderSpecs.delete(provider);
}

export function resetHealthProviderRegistry(): void {
  healthProviderSpecs.clear();
  for (const [name, spec] of Object.entries(DEFAULT_HEALTH_PROVIDER_SPECS)) {
    healthProviderSpecs.set(name, spec);
  }
}
