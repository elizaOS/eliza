/**
 * Covers Google OAuth provider metadata and capability-scoped config.
 * Pins fixed endpoint URLs, settings keys, and capability-to-scope derivation
 * so the connector manager never negotiates the wrong OAuth grant.
 */
import { describe, expect, it } from "vitest";

import {
  GOOGLE_OAUTH_PROVIDER_METADATA,
  getGoogleOAuthProviderConfig,
  getGoogleOAuthProviderMetadata,
  MissingGoogleCredentialResolver,
} from "./auth";
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_IDENTITY_SCOPES,
  normalizeGoogleCapabilities,
  scopesForGoogleCapabilities,
} from "./scopes";
import { GOOGLE_SERVICE_NAME } from "./types";

describe("GOOGLE_OAUTH_PROVIDER_METADATA", () => {
  it("exposes fixed Google OAuth endpoints and settings keys", () => {
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.provider).toBe(GOOGLE_SERVICE_NAME);
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.label).toBe("Google Workspace");
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.authorizationEndpoint).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.tokenEndpoint).toBe(
      "https://oauth2.googleapis.com/token"
    );
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.revokeEndpoint).toBe(
      "https://oauth2.googleapis.com/revoke"
    );
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.clientIdSetting).toBe("GOOGLE_CLIENT_ID");
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.clientSecretSetting).toBe("GOOGLE_CLIENT_SECRET");
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.redirectUriSetting).toBe("GOOGLE_REDIRECT_URI");
  });

  it("uses code flow with offline access and consent prompt, plus PKCE", () => {
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.responseType).toBe("code");
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.accessType).toBe("offline");
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.prompt).toBe("consent");
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.supportsPkce).toBe(true);
  });

  it("carries identity scopes and full capability catalog", () => {
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.identityScopes).toEqual(GOOGLE_IDENTITY_SCOPES);
    expect(GOOGLE_OAUTH_PROVIDER_METADATA.capabilities).toEqual(GOOGLE_CAPABILITIES);
  });
});

describe("getGoogleOAuthProviderMetadata", () => {
  it("returns the singleton metadata object", () => {
    expect(getGoogleOAuthProviderMetadata()).toBe(GOOGLE_OAUTH_PROVIDER_METADATA);
  });
});

describe("getGoogleOAuthProviderConfig", () => {
  it("derives authUrl/tokenUrl from metadata and empty capabilities to identity scopes only", () => {
    const config = getGoogleOAuthProviderConfig([]);
    expect(config.provider).toBe(GOOGLE_SERVICE_NAME);
    expect(config.authUrl).toBe(GOOGLE_OAUTH_PROVIDER_METADATA.authorizationEndpoint);
    expect(config.tokenUrl).toBe(GOOGLE_OAUTH_PROVIDER_METADATA.tokenEndpoint);
    expect(config.capabilities).toEqual([]);
    expect(config.scopes).toEqual(scopesForGoogleCapabilities([]));
    expect(config.scopes).toEqual(expect.arrayContaining([...GOOGLE_IDENTITY_SCOPES]));
  });

  it("normalizes capabilities and derives scopes via scopesForGoogleCapabilities", () => {
    const config = getGoogleOAuthProviderConfig(["drive.read", "calendar.read"]);
    expect(config.capabilities).toEqual(
      normalizeGoogleCapabilities(["drive.read", "calendar.read"])
    );
    expect(config.scopes).toEqual(
      scopesForGoogleCapabilities(normalizeGoogleCapabilities(["drive.read", "calendar.read"]))
    );
  });

  it("deduplicates and drops unknown capabilities", () => {
    const config = getGoogleOAuthProviderConfig([
      "drive.read",
      "drive.read",
      // @ts-expect-error intentional unknown capability
      "unknown.capability",
      "calendar.read",
    ]);
    expect(config.capabilities).toEqual(["drive.read", "calendar.read"]);
    // unknown capability must not contribute scopes
    const expected = scopesForGoogleCapabilities(["drive.read", "calendar.read"]);
    expect(config.scopes).toEqual(expected);
  });

  it("always sets authorizationParams to offline/consent without incremental grant", () => {
    const config = getGoogleOAuthProviderConfig(["gmail.read"]);
    expect(config.authorizationParams).toEqual({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
    });
  });

  it("includes identity scopes for any capability set", () => {
    const config = getGoogleOAuthProviderConfig(["people.read"]);
    for (const scope of GOOGLE_IDENTITY_SCOPES) {
      expect(config.scopes).toContain(scope);
    }
  });
});

describe("MissingGoogleCredentialResolver", () => {
  it("throws with accountId and requested capabilities/scopes", async () => {
    const resolver = new MissingGoogleCredentialResolver();
    await expect(
      resolver.getAuthClient({
        accountId: "acct-123",
        capabilities: ["drive.read"],
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        // minimal shape - other fields optional per type
      } as never)
    ).rejects.toThrow(/acct-123/);
    await expect(
      resolver.getAuthClient({
        accountId: "acct-123",
        capabilities: ["drive.read"],
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      } as never)
    ).rejects.toThrow(/drive\.read/);
  });

  it("mentions identity fallback when no capabilities/scopes", async () => {
    const resolver = new MissingGoogleCredentialResolver();
    await expect(
      resolver.getAuthClient({
        accountId: "acct-xyz",
        capabilities: [],
        scopes: [],
      } as never)
    ).rejects.toThrow(/identity/);
  });
});
