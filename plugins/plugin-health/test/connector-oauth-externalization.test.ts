/**
 * Connector OAuth + base-URL externalisation regression test.
 *
 * Covers the audit C top-3 finding (`rigidity-hunt-audit.md` §3): per-provider
 * OAuth + API base URLs used to live in `switch (provider)` arms inside
 * `health-oauth.ts` and `health-connectors.ts`. After externalisation, every
 * URL is sourced from the `HealthProviderRegistry` and surfaced on the
 * connector contribution's `oauth` / `apiBaseUrl` fields. This test asserts:
 *
 *   1. Default-built connector contributions for strava / fitbit / withings /
 *      oura carry the registered URLs on `.oauth` and `.apiBaseUrl`.
 *   2. The OAuth dispatcher (`startHealthConnectorOAuth`) reads the registered
 *      authorize URL — registering a synthetic `acme_health` provider with a
 *      custom URL is enough to drive the flow through it.
 *   3. The API-base resolver throws `MissingOauthConfigError` when the
 *      registry has no entry for the requested provider — failing loud
 *      instead of silently returning a default endpoint.
 *
 * The test runs entirely in-process with no network: the mock-base env
 * (`ELIZA_MOCK_HEALTH_BASE`) shadows the real apiBaseUrl during fetch
 * verification, so we drive `fetch` through a stub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConnectorContribution,
  type ConnectorRegistry,
  type HEALTH_CONNECTOR_KINDS,
  registerHealthConnectors,
} from "../src/connectors/index.js";
import { syncHealthConnectorData } from "../src/health-bridge/health-connectors.js";
import {
  type StoredHealthConnectorToken,
  startHealthConnectorOAuth,
} from "../src/health-bridge/health-oauth.js";
import {
  deleteHealthProviderSpec,
  getHealthProviderSpec,
  type HealthProviderSpec,
  MissingOauthConfigError,
  resetHealthProviderRegistry,
  setHealthProviderSpec,
} from "../src/health-bridge/health-provider-registry.js";

function makeConnectorRegistry(): {
  registry: ConnectorRegistry;
  list: ConnectorContribution[];
} {
  const list: ConnectorContribution[] = [];
  const registry: ConnectorRegistry = {
    register: (c) => {
      list.push(c);
    },
    list: () => list,
    get: (kind) => list.find((c) => c.kind === kind) ?? null,
    byCapability: (capability) =>
      list.filter((c) => c.capabilities.includes(capability)),
  };
  return { registry, list };
}

const ORIGINAL_ENV = { ...process.env };

describe("health connector OAuth + base-URL externalisation (Audit C top-3)", () => {
  beforeEach(() => {
    resetHealthProviderRegistry();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    resetHealthProviderRegistry();
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("registers strava/fitbit/withings/oura with oauth + apiBaseUrl pulled from the provider registry", () => {
    const { registry, list } = makeConnectorRegistry();
    registerHealthConnectors({ connectorRegistry: registry });

    const expected: Array<{
      kind: (typeof HEALTH_CONNECTOR_KINDS)[number];
      authorizeUrl: string;
      tokenUrl: string;
      apiBaseUrl: string;
    }> = [
      {
        kind: "strava",
        authorizeUrl: "https://www.strava.com/oauth/authorize",
        tokenUrl: "https://www.strava.com/oauth/token",
        apiBaseUrl: "https://www.strava.com/api/v3",
      },
      {
        kind: "fitbit",
        authorizeUrl: "https://www.fitbit.com/oauth2/authorize",
        tokenUrl: "https://api.fitbit.com/oauth2/token",
        apiBaseUrl: "https://api.fitbit.com",
      },
      {
        kind: "withings",
        authorizeUrl: "https://account.withings.com/oauth2_user/authorize2",
        tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
        apiBaseUrl: "https://wbsapi.withings.net",
      },
      {
        kind: "oura",
        authorizeUrl: "https://cloud.ouraring.com/oauth/authorize",
        tokenUrl: "https://api.ouraring.com/oauth/token",
        apiBaseUrl: "https://api.ouraring.com",
      },
    ];

    for (const e of expected) {
      const contribution = list.find((c) => c.kind === e.kind);
      expect(contribution, `${e.kind} contribution registered`).toBeDefined();
      if (!contribution) throw new Error(`missing ${e.kind}`);
      expect(contribution.oauth?.authorizeUrl).toBe(e.authorizeUrl);
      expect(contribution.oauth?.tokenUrl).toBe(e.tokenUrl);
      expect(contribution.apiBaseUrl).toBe(e.apiBaseUrl);
    }
  });

  it("apple_health and google_fit have no oauth / apiBaseUrl (registry has no entry)", () => {
    const { registry, list } = makeConnectorRegistry();
    registerHealthConnectors({ connectorRegistry: registry });

    const apple = list.find((c) => c.kind === "apple_health");
    const google = list.find((c) => c.kind === "google_fit");
    expect(apple?.oauth).toBeUndefined();
    expect(apple?.apiBaseUrl).toBeUndefined();
    expect(google?.oauth).toBeUndefined();
    expect(google?.apiBaseUrl).toBeUndefined();
  });

  it("startHealthConnectorOAuth sources the authorize URL from the registry — registering a synthetic acme provider routes through its URL", () => {
    const acmeSpec: HealthProviderSpec = {
      provider: "acme_health" as const,
      envPrefix: "ACME",
      oauth: {
        authorizeUrl: "https://acme.example/oauth/authorize",
        tokenUrl: "https://acme.example/oauth/token",
        revokeUrl: null,
        defaultScopes: ["acme.read"],
        scopeSeparator: "space",
        usePkce: false,
        tokenRequestStyle: "form",
      },
      apiBaseUrl: "https://acme.example/api/v1",
      capabilities: ["health.activity.read"],
    };
    setHealthProviderSpec(acmeSpec);
    process.env.ELIZA_ACME_CLIENT_ID = "test-client-id";
    process.env.ELIZA_ACME_CLIENT_SECRET = "test-client-secret";

    // The OAuth dispatcher's provider type is `LifeOpsHealthConnectorProvider`
    // (a closed union for the four built-in OAuth providers). Externalisation
    // means the *URL data* lives in the registry — the dispatcher reads URLs
    // by provider name without a switch. We exercise that path by overriding
    // the registered strava entry with the acme spec, then asserting the
    // authorize URL routes through the acme endpoint.
    setHealthProviderSpec({ ...acmeSpec, provider: "strava" });
    process.env.ELIZA_STRAVA_CLIENT_ID = "test-client-id";
    process.env.ELIZA_STRAVA_CLIENT_SECRET = "test-client-secret";

    const result = startHealthConnectorOAuth({
      provider: "strava",
      agentId: "agent-1",
      side: "owner",
      mode: "local",
      requestUrl: new URL("http://127.0.0.1:31337/api"),
    });
    const parsed = new URL(result.authUrl);
    expect(parsed.origin).toBe("https://acme.example");
    expect(parsed.pathname).toBe("/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
    expect(parsed.searchParams.get("scope")).toBe("acme.read");
  });

  it("requireHealthProviderSpec throws MissingOauthConfigError when the provider has no registered entry", async () => {
    deleteHealthProviderSpec("strava");
    expect(getHealthProviderSpec("strava")).toBeNull();
    process.env.ELIZA_STRAVA_CLIENT_ID = "test-client-id";
    process.env.ELIZA_STRAVA_CLIENT_SECRET = "test-client-secret";

    expect(() =>
      startHealthConnectorOAuth({
        provider: "strava",
        agentId: "agent-1",
        side: "owner",
        mode: "local",
        requestUrl: new URL("http://127.0.0.1:31337/api"),
      }),
    ).toThrow(MissingOauthConfigError);
  });

  it("syncHealthConnectorData routes API calls through the registry's apiBaseUrl (no hardcoded host)", async () => {
    setHealthProviderSpec({
      provider: "strava",
      envPrefix: "STRAVA",
      oauth: {
        authorizeUrl: "https://acme.example/oauth/authorize",
        tokenUrl: "https://acme.example/oauth/token",
        revokeUrl: null,
        defaultScopes: ["acme.read"],
        scopeSeparator: "space",
        usePkce: false,
        tokenRequestStyle: "form",
      },
      apiBaseUrl: "https://acme.example/api/v1",
      capabilities: ["health.activity.read", "health.workouts.read"],
    });

    const fetchedUrls: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        fetchedUrls.push(url);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    const token: StoredHealthConnectorToken = {
      provider: "strava",
      agentId: "agent-1",
      side: "owner",
      mode: "local",
      clientId: "test",
      clientSecret: "secret",
      redirectUri: "http://127.0.0.1/redirect",
      accessToken: "access",
      refreshToken: null,
      tokenType: "Bearer",
      grantedScopes: ["acme.read"],
      expiresAt: null,
      identity: {},
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };

    await syncHealthConnectorData({
      token,
      grantId: "grant-1",
      startDate: "2026-05-01",
      endDate: "2026-05-02",
    });

    expect(fetchSpy).toHaveBeenCalled();
    expect(fetchedUrls.length).toBeGreaterThan(0);
    for (const url of fetchedUrls) {
      expect(url.startsWith("https://acme.example/api/v1")).toBe(true);
    }
  });

  it("setHealthProviderSpec / resetHealthProviderRegistry round-trip restores the four canonical providers", () => {
    setHealthProviderSpec({
      provider: "synthetic",
      envPrefix: "SYNTH",
      oauth: {
        authorizeUrl: "https://example/auth",
        tokenUrl: "https://example/token",
        revokeUrl: null,
        defaultScopes: [],
        scopeSeparator: "space",
        usePkce: false,
        tokenRequestStyle: "form",
      },
      apiBaseUrl: "https://example",
      capabilities: [],
    });
    deleteHealthProviderSpec("oura");
    expect(getHealthProviderSpec("synthetic")).not.toBeNull();
    expect(getHealthProviderSpec("oura")).toBeNull();

    resetHealthProviderRegistry();
    expect(getHealthProviderSpec("synthetic")).toBeNull();
    expect(getHealthProviderSpec("oura")).not.toBeNull();
    expect(getHealthProviderSpec("strava")).not.toBeNull();
  });
});
