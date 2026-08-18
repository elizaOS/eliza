/**
 * Exercises provider-registry lookup, scope, and credential diagnostics with
 * deterministic cloud-binding contexts and no external OAuth traffic.
 */
import { describe, expect, test } from "vitest";
import { runWithCloudBindings } from "../../runtime/cloud-bindings";
import {
  getAllowedScopes,
  getAllProviderIds,
  getCallbackUrl,
  getNestedValue,
  getProvider,
  getProviderEnvDiagnostics,
  isProviderConfigured,
  isValidProvider,
  type OAuthProviderConfig,
  resolveCapabilityScopes,
  resolveRequestedScopes,
} from "./provider-registry";

const provider = (o: Partial<OAuthProviderConfig>): OAuthProviderConfig =>
  ({
    id: "test",
    type: "oauth2",
    envVars: [],
    useGenericRoutes: true,
    allowedScopes: ["read", "write"],
    defaultScopes: ["read"],
    ...o,
  }) as OAuthProviderConfig;

describe("provider lookup", () => {
  test("getProvider is case-insensitive; isValidProvider matches the registry", () => {
    const id = getAllProviderIds()[0];
    expect(getAllProviderIds().length).toBeGreaterThan(0);
    expect(getProvider(id.toUpperCase())?.id).toBeDefined();
    expect(getProvider("definitely-not-a-provider")).toBeNull();
    expect(isValidProvider(id)).toBe(true);
    expect(isValidProvider("definitely-not-a-provider")).toBe(false);
  });
});

describe("getAllowedScopes / resolveRequestedScopes", () => {
  test("allowed scopes fall back default → allowed, normalized + deduped", () => {
    expect(getAllowedScopes(provider({}))).toEqual(["read", "write"]);
    expect(
      getAllowedScopes(provider({ allowedScopes: undefined, defaultScopes: ["x", "x"] })),
    ).toEqual(["x"]);
  });

  test("empty request → default scopes; valid request passes; invalid THROWS", () => {
    const p = provider({});
    expect(resolveRequestedScopes(p, [])).toEqual(["read"]); // default
    expect(resolveRequestedScopes(p, ["read", " write "])).toEqual(["read", "write"]);
    // 'admin' is not in the allowlist → scope-escalation attempt must throw.
    expect(() => resolveRequestedScopes(p, ["read", "admin"])).toThrow();
  });
});

describe("resolveCapabilityScopes", () => {
  test("keeps the seven incremental providers on a least-privilege baseline", () => {
    const incrementalProviders = [
      "google",
      "microsoft",
      "github",
      "linear",
      "slack",
      "salesforce",
      "airtable",
    ];

    for (const providerId of incrementalProviders) {
      const configuredProvider = getProvider(providerId) as OAuthProviderConfig;
      expect(configuredProvider.baselineScopes).toEqual(configuredProvider.defaultScopes);
      expect(configuredProvider.capabilityScopes).toBeDefined();
      expect(getAllowedScopes(configuredProvider)).toEqual(
        expect.arrayContaining(configuredProvider.baselineScopes ?? []),
      );
    }
  });

  test("classifies user, review, and admin consent and becomes retry-ready after grant", () => {
    const configuredProvider = provider({
      baselineScopes: ["identity"],
      allowedScopes: ["identity", "read", "write", "admin"],
      capabilityScopes: {
        read: { scopes: ["read"], consent: "user" },
        write: { scopes: ["write"], consent: "review" },
        admin: { scopes: ["admin"], consent: "admin" },
      },
    });

    expect(resolveCapabilityScopes(configuredProvider, ["read"]).status).toBe("needs_scope");
    expect(resolveCapabilityScopes(configuredProvider, ["write"]).status).toBe("needs_review");
    const escalation = resolveCapabilityScopes(configuredProvider, ["admin"]);
    expect(escalation).toMatchObject({
      status: "needs_admin",
      scopes: ["identity", "admin"],
      missingScopes: ["identity", "admin"],
      retryAfterConsent: true,
    });
    expect(resolveCapabilityScopes(configuredProvider, ["admin"], escalation.scopes)).toMatchObject(
      { status: "ready", missingScopes: [], retryAfterConsent: false },
    );
  });

  test("keeps Slack user scopes separate and rejects unknown capabilities", () => {
    const slack = getProvider("slack") as OAuthProviderConfig;
    const resolution = resolveCapabilityScopes(slack, ["messages.search"]);

    expect(resolution.scopes).toEqual(["channels:read"]);
    expect(resolution.userScopes).toEqual(
      expect.arrayContaining(["identity.basic", "users:read", "search:read"]),
    );
    expect(() => resolveCapabilityScopes(slack, ["workspace.admin"])).toThrow();
  });

  test("preserves raw-scope compatibility for existing callers and grants", () => {
    const google = getProvider("google") as OAuthProviderConfig;
    const legacyScopes = [
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/gmail.send",
    ];

    expect(resolveRequestedScopes(google, legacyScopes)).toEqual(legacyScopes);
    expect(resolveCapabilityScopes(google, ["mail.send"], legacyScopes)).toMatchObject({
      status: "ready",
      missingScopes: [],
      retryAfterConsent: false,
    });
  });

  test("rejects malformed scope and capability arrays at the service boundary", () => {
    const configuredProvider = provider({});
    expect(() => resolveRequestedScopes(configuredProvider, "read" as never)).toThrow();
    expect(() => resolveCapabilityScopes(configuredProvider, [7] as never)).toThrow();
  });
});

describe("getCallbackUrl / getNestedValue", () => {
  test("generic callback URL is built from the base + provider id", () => {
    expect(getCallbackUrl(provider({ id: "x" }), "https://h.io")).toBe(
      "https://h.io/api/v1/oauth/x/callback",
    );
  });

  test("getNestedValue walks dot paths and is null-safe", () => {
    const obj = { data: { viewer: { id: "abc" } } };
    expect(getNestedValue(obj, "data.viewer.id")).toBe("abc");
    expect(getNestedValue(obj, "data.missing.id")).toBeUndefined();
    expect(getNestedValue(null, "a.b")).toBeUndefined();
  });
});

describe("getProviderEnvDiagnostics", () => {
  test("returns one entry per provider with configured + missingEnvVars fields", () => {
    const diagnostics = getProviderEnvDiagnostics();
    const providerIds = getAllProviderIds();

    expect(diagnostics).toHaveLength(providerIds.length);

    for (const entry of diagnostics) {
      expect(entry.id).toBeDefined();
      expect(entry.name).toBeDefined();
      expect(entry.type).toBeDefined();
      expect(typeof entry.configured).toBe("boolean");
      expect(Array.isArray(entry.missingEnvVars)).toBe(true);
      expect(typeof entry.requiredForDeployment).toBe("boolean");

      if (entry.configured) {
        expect(entry.missingEnvVars).toEqual([]);
      } else {
        expect(entry.missingEnvVars.length).toBeGreaterThan(0);
      }
    }
  });

  test("entries map 1:1 to the registry by id", () => {
    const diagnostics = getProviderEnvDiagnostics();
    const providerIds = new Set(getAllProviderIds());
    const diagnosticIds = new Set(diagnostics.map((d) => d.id));
    expect(diagnosticIds).toEqual(providerIds);
  });

  test("Twitter reports the satisfied alternative instead of contradictory missing vars", () => {
    const twitter = getProvider("twitter") as OAuthProviderConfig;
    const result = runWithCloudBindings(
      {
        TWITTER_API_KEY: "",
        TWITTER_API_SECRET_KEY: "",
        TWITTER_CLIENT_ID: "client-id",
      },
      () => ({
        configured: isProviderConfigured(twitter),
        diagnostic: getProviderEnvDiagnostics().find((d) => d.id === "twitter"),
      }),
    );

    expect(result.configured).toBe(true);
    expect(result.diagnostic).toMatchObject({
      configured: true,
      missingEnvVars: [],
    });
  });

  test("reports the shortest actionable alternative when no Twitter path is complete", () => {
    const diagnostic = runWithCloudBindings(
      {
        TWITTER_API_KEY: "",
        TWITTER_API_SECRET_KEY: "",
        TWITTER_CLIENT_ID: "",
      },
      () => getProviderEnvDiagnostics().find((d) => d.id === "twitter"),
    );

    expect(diagnostic).toMatchObject({
      configured: false,
      missingEnvVars: ["TWITTER_CLIENT_ID"],
    });
  });

  test("respects runWithCloudBindings context for env-var detection", () => {
    const inside = runWithCloudBindings(
      { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" },
      () => getProviderEnvDiagnostics().find((d) => d.id === "google"),
    );

    expect(inside).toBeDefined();
    expect(inside?.missingEnvVars).toEqual([]);
    expect(inside?.configured).toBe(true);
    expect(inside?.requiredForDeployment).toBe(true);
  });

  test("rejects whitespace-only required Google credentials", () => {
    const google = getProvider("google") as OAuthProviderConfig;
    const diagnostic = runWithCloudBindings(
      { GOOGLE_CLIENT_ID: "  ", GOOGLE_CLIENT_SECRET: "\t" },
      () => getProviderEnvDiagnostics().find((d) => d.id === "google"),
    );
    const configured = runWithCloudBindings(
      { GOOGLE_CLIENT_ID: "  ", GOOGLE_CLIENT_SECRET: "\t" },
      () => isProviderConfigured(google),
    );

    expect(configured).toBe(false);
    expect(diagnostic).toMatchObject({
      configured: false,
      requiredForDeployment: true,
      missingEnvVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    });
  });
});
