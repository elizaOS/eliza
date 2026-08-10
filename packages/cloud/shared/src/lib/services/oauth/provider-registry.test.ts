// Exercises provider registry behavior with deterministic cloud-shared lib fixtures.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GOOGLE_OAUTH_CLIENT_SECRET_VAULT_NAME,
  getAllowedScopes,
  getAllProviderIds,
  getCallbackUrl,
  getNestedValue,
  getProvider,
  isValidProvider,
  type OAuthProviderConfig,
  resolveOAuthClientCredentials,
  resolveRequestedScopes,
} from "./provider-registry";

const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
const originalGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

afterEach(() => {
  if (originalGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = originalGoogleClientId;
  if (originalGoogleClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = originalGoogleClientSecret;
});

/**
 * OAuth provider registry. The security-critical piece is resolveRequestedScopes:
 * a requested scope not in the provider's allowlist must THROW (no scope
 * escalation); empty requests fall back to default scopes. Provider lookup is
 * case-insensitive and getNestedValue must never throw on missing paths.
 */

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

  test("never allows legacy Calendar grants to be newly requested", () => {
    const google = getProvider("google");
    if (!google) throw new Error("google provider must exist");
    const legacyScopes = [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar",
    ];

    expect(getAllowedScopes(google)).not.toEqual(expect.arrayContaining(legacyScopes));
    expect(google.defaultScopes).not.toEqual(expect.arrayContaining(legacyScopes));
    for (const legacyScope of legacyScopes) {
      expect(() => resolveRequestedScopes(google, [legacyScope])).toThrow();
    }
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

describe("Google OAuth client credential vault", () => {
  test("requires and prefers the organization-vault client secret", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "env-client-secret";
    const google = getProvider("google");
    if (!google) throw new Error("google provider must exist");
    const create = vi.fn();
    const secretStore = {
      get: vi.fn(async () => "vault-client-secret"),
      create,
    };

    await expect(
      resolveOAuthClientCredentials(
        google,
        {
          organizationId: "org-1",
          actorId: "user-1",
          source: "test",
        },
        secretStore,
      ),
    ).resolves.toEqual({
      clientId: "google-client-id",
      clientSecret: "vault-client-secret",
    });
    expect(create).not.toHaveBeenCalled();
  });

  test("fails closed when only the legacy env secret exists and migration is disabled", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "env-client-secret";
    const google = getProvider("google");
    if (!google) throw new Error("google provider must exist");
    const secretStore = {
      get: vi.fn(async () => null),
      create: vi.fn(),
    };

    await expect(
      resolveOAuthClientCredentials(
        google,
        {
          organizationId: "org-1",
          actorId: "user-1",
          source: "test",
        },
        secretStore,
      ),
    ).rejects.toThrow(GOOGLE_OAUTH_CLIENT_SECRET_VAULT_NAME);
    expect(secretStore.create).not.toHaveBeenCalled();
  });

  test("migrates the legacy env secret only when explicitly enabled and readable from vault", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "env-client-secret";
    const google = getProvider("google");
    if (!google) throw new Error("google provider must exist");
    let vaultValue: string | null = null;
    const secretStore = {
      get: vi.fn(async () => vaultValue),
      create: vi.fn(async (input: { value: string }) => {
        vaultValue = input.value;
        return { id: "secret-1" };
      }),
    };

    await expect(
      resolveOAuthClientCredentials(
        google,
        {
          organizationId: "org-1",
          actorId: "user-1",
          source: "test",
          allowGoogleEnvMigration: true,
        },
        secretStore,
      ),
    ).resolves.toEqual({
      clientId: "google-client-id",
      clientSecret: "env-client-secret",
    });
    expect(secretStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: GOOGLE_OAUTH_CLIENT_SECRET_VAULT_NAME,
        value: "env-client-secret",
      }),
      expect.anything(),
    );
    expect(secretStore.get).toHaveBeenCalledTimes(2);
  });
});
