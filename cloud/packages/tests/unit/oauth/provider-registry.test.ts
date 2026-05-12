/**
 * OAuth Provider Registry Unit Tests
 *
 * Tests provider configuration, environment variable detection, and provider lookup.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

type PR = typeof import("@/lib/services/oauth/provider-registry");

describe("Provider Registry", () => {
  let getProvider: PR["getProvider"];
  let getAllProviderIds: PR["getAllProviderIds"];
  let getConfiguredProviders: PR["getConfiguredProviders"];
  let getAllowedScopes: PR["getAllowedScopes"];
  let isProviderConfigured: PR["isProviderConfigured"];
  let isValidProvider: PR["isValidProvider"];
  let OAUTH_PROVIDERS: PR["OAUTH_PROVIDERS"];
  let resolveRequestedScopes: PR["resolveRequestedScopes"];

  beforeEach(async () => {
    const m = await import(`@/lib/services/oauth/provider-registry?t=${Date.now()}`);
    getProvider = m.getProvider;
    getAllProviderIds = m.getAllProviderIds;
    getConfiguredProviders = m.getConfiguredProviders;
    getAllowedScopes = m.getAllowedScopes;
    isProviderConfigured = m.isProviderConfigured;
    isValidProvider = m.isValidProvider;
    OAUTH_PROVIDERS = m.OAUTH_PROVIDERS;
    resolveRequestedScopes = m.resolveRequestedScopes;
  });

  describe("OAUTH_PROVIDERS", () => {
    it("should include all expected providers", () => {
      const expectedProviders = ["google", "twitter", "twilio", "blooio"];

      for (const provider of expectedProviders) {
        expect(OAUTH_PROVIDERS[provider]).toBeDefined();
      }
    });

    it("should NOT include Discord (excluded by design)", () => {
      expect(OAUTH_PROVIDERS["discord"]).toBeUndefined();
    });

    it("should have required fields for each provider", () => {
      for (const [id, provider] of Object.entries(OAUTH_PROVIDERS)) {
        expect(provider.id).toBe(id);
        expect(provider.name).toBeDefined();
        expect(typeof provider.name).toBe("string");
        expect(provider.description).toBeDefined();
        expect(typeof provider.description).toBe("string");
        expect(provider.type).toBeDefined();
        expect(["oauth2", "oauth1a", "api_key"]).toContain(provider.type);
        expect(provider.envVars).toBeDefined();
        expect(Array.isArray(provider.envVars)).toBe(true);
        expect(provider.storage).toBeDefined();
        expect(["platform_credentials", "secrets"]).toContain(provider.storage);
        // Generic route providers don't need routes config
        if (!provider.useGenericRoutes) {
          expect(provider.routes).toBeDefined();
          expect(provider.routes!.initiate).toBeDefined();
          expect(provider.routes!.status).toBeDefined();
          expect(provider.routes!.disconnect).toBeDefined();
        }
      }
    });

    describe("Google Provider", () => {
      it("should have correct type", () => {
        expect(OAUTH_PROVIDERS.google.type).toBe("oauth2");
      });

      it("should require GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", () => {
        expect(OAUTH_PROVIDERS.google.envVars).toContain("GOOGLE_CLIENT_ID");
        expect(OAUTH_PROVIDERS.google.envVars).toContain("GOOGLE_CLIENT_SECRET");
      });

      it("should use platform_credentials storage", () => {
        expect(OAUTH_PROVIDERS.google.storage).toBe("platform_credentials");
      });

      it("should have default scopes", () => {
        expect(OAUTH_PROVIDERS.google.defaultScopes).toBeDefined();
        expect(Array.isArray(OAUTH_PROVIDERS.google.defaultScopes)).toBe(true);
        expect(OAUTH_PROVIDERS.google.defaultScopes!.length).toBeGreaterThan(0);
      });

      it("should use generic routes", () => {
        expect(OAUTH_PROVIDERS.google.useGenericRoutes).toBe(true);
        expect(OAUTH_PROVIDERS.google.routes).toBeUndefined();
      });
    });

    describe("Twitter Provider", () => {
      it("should have OAuth 1.0a type", () => {
        expect(OAUTH_PROVIDERS.twitter.type).toBe("oauth1a");
      });

      it("should require Twitter API keys", () => {
        expect(OAUTH_PROVIDERS.twitter.envVars).toContain("TWITTER_API_KEY");
        expect(OAUTH_PROVIDERS.twitter.envVars).toContain("TWITTER_API_SECRET_KEY");
      });

      it("should use secrets storage", () => {
        expect(OAUTH_PROVIDERS.twitter.storage).toBe("secrets");
      });

      it("should have secret patterns defined", () => {
        expect(OAUTH_PROVIDERS.twitter.secretPatterns).toBeDefined();
        expect(OAUTH_PROVIDERS.twitter.secretPatterns!.accessToken).toBe("TWITTER_ACCESS_TOKEN");
        expect(OAUTH_PROVIDERS.twitter.secretPatterns!.accessTokenSecret).toBe(
          "TWITTER_ACCESS_TOKEN_SECRET",
        );
        expect(OAUTH_PROVIDERS.twitter.secretPatterns!.username).toBe("TWITTER_USERNAME");
        expect(OAUTH_PROVIDERS.twitter.secretPatterns!.userId).toBe("TWITTER_USER_ID");
      });
    });

    describe("Twilio Provider", () => {
      it("should have api_key type", () => {
        expect(OAUTH_PROVIDERS.twilio.type).toBe("api_key");
      });

      it("should have empty envVars (user provides credentials)", () => {
        expect(OAUTH_PROVIDERS.twilio.envVars).toEqual([]);
      });

      it("should use secrets storage", () => {
        expect(OAUTH_PROVIDERS.twilio.storage).toBe("secrets");
      });

      it("should have secret patterns defined", () => {
        expect(OAUTH_PROVIDERS.twilio.secretPatterns).toBeDefined();
        expect(OAUTH_PROVIDERS.twilio.secretPatterns!.accountSid).toBe("TWILIO_ACCOUNT_SID");
        expect(OAUTH_PROVIDERS.twilio.secretPatterns!.authToken).toBe("TWILIO_AUTH_TOKEN");
        expect(OAUTH_PROVIDERS.twilio.secretPatterns!.phoneNumber).toBe("TWILIO_PHONE_NUMBER");
      });

      it("should have empty callback route (API key platforms)", () => {
        expect(OAUTH_PROVIDERS.twilio.routes!.callback).toBe("");
      });
    });

    describe("Blooio Provider", () => {
      it("should have api_key type", () => {
        expect(OAUTH_PROVIDERS.blooio.type).toBe("api_key");
      });

      it("should have empty envVars (user provides credentials)", () => {
        expect(OAUTH_PROVIDERS.blooio.envVars).toEqual([]);
      });

      it("should use secrets storage", () => {
        expect(OAUTH_PROVIDERS.blooio.storage).toBe("secrets");
      });

      it("should have secret patterns defined", () => {
        expect(OAUTH_PROVIDERS.blooio.secretPatterns).toBeDefined();
        expect(OAUTH_PROVIDERS.blooio.secretPatterns!.apiKey).toBe("BLOOIO_API_KEY");
        expect(OAUTH_PROVIDERS.blooio.secretPatterns!.webhookSecret).toBe("BLOOIO_WEBHOOK_SECRET");
        expect(OAUTH_PROVIDERS.blooio.secretPatterns!.fromNumber).toBe("BLOOIO_FROM_NUMBER");
      });
    });
  });

  describe("getProvider", () => {
    it("should return provider for valid ID", () => {
      const provider = getProvider("google");
      expect(provider).toBeDefined();
      expect(provider!.id).toBe("google");
    });

    it("should return null for invalid ID", () => {
      const provider = getProvider("invalid");
      expect(provider).toBeNull();
    });

    it("should return null for empty string", () => {
      const provider = getProvider("");
      expect(provider).toBeNull();
    });

    it("should be case-insensitive", () => {
      const provider = getProvider("GOOGLE");
      expect(provider).not.toBeNull();
      expect(provider!.id).toBe("google");
    });

    it("should return all expected providers", () => {
      const expectedProviders = ["google", "twitter", "twilio", "blooio"];

      for (const id of expectedProviders) {
        const provider = getProvider(id);
        expect(provider).not.toBeNull();
        expect(provider!.id).toBe(id);
      }
    });
  });

  describe("scope resolution", () => {
    it("returns normalized default scopes when no scopes are requested", () => {
      const scopes = resolveRequestedScopes(OAUTH_PROVIDERS.google, undefined);

      expect(scopes).toEqual(getAllowedScopes(OAUTH_PROVIDERS.google));
    });

    it("dedupes and trims requested scopes within the allowlist", () => {
      const provider = {
        ...OAUTH_PROVIDERS.google,
        allowedScopes: ["scope:a", "scope:b"],
        defaultScopes: ["scope:a"],
      };

      expect(resolveRequestedScopes(provider, [" scope:a ", "scope:b", "scope:a"])).toEqual([
        "scope:a",
        "scope:b",
      ]);
    });

    it("rejects requested scopes outside the allowlist", () => {
      const provider = {
        ...OAUTH_PROVIDERS.google,
        allowedScopes: ["scope:a"],
        defaultScopes: ["scope:a"],
      };

      expect(() => resolveRequestedScopes(provider, ["scope:a", "scope:admin"])).toThrow(
        "Requested scopes are not allowed",
      );
    });
  });

  describe("isProviderConfigured", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      // Create a shallow copy of process.env
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should return true for API key providers (empty envVars)", () => {
      const twilio = OAUTH_PROVIDERS.twilio;
      const blooio = OAUTH_PROVIDERS.blooio;

      expect(isProviderConfigured(twilio)).toBe(true);
      expect(isProviderConfigured(blooio)).toBe(true);
    });

    it("should return false when Google env vars are missing", () => {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;

      const google = OAUTH_PROVIDERS.google;
      expect(isProviderConfigured(google)).toBe(false);
    });

    it("should return true when all Google env vars are set", () => {
      process.env.GOOGLE_CLIENT_ID = "test-client-id";
      process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

      const google = OAUTH_PROVIDERS.google;
      expect(isProviderConfigured(google)).toBe(true);
    });

    it("should return false when only some env vars are set", () => {
      process.env.GOOGLE_CLIENT_ID = "test-client-id";
      delete process.env.GOOGLE_CLIENT_SECRET;

      const google = OAUTH_PROVIDERS.google;
      expect(isProviderConfigured(google)).toBe(false);
    });

    it("should return false when env vars are empty strings", () => {
      process.env.GOOGLE_CLIENT_ID = "";
      process.env.GOOGLE_CLIENT_SECRET = "test-secret";

      const google = OAUTH_PROVIDERS.google;
      expect(isProviderConfigured(google)).toBe(false);
    });

    it("should return false when Twitter env vars are missing", () => {
      delete process.env.TWITTER_API_KEY;
      delete process.env.TWITTER_API_SECRET_KEY;
      delete process.env.TWITTER_CLIENT_ID;

      const twitter = OAUTH_PROVIDERS.twitter;
      expect(isProviderConfigured(twitter)).toBe(false);
    });

    it("should return true when Twitter OAuth 1.0a env vars are set", () => {
      process.env.TWITTER_API_KEY = "test-api-key";
      process.env.TWITTER_API_SECRET_KEY = "test-api-secret";
      delete process.env.TWITTER_CLIENT_ID;

      const twitter = OAUTH_PROVIDERS.twitter;
      expect(isProviderConfigured(twitter)).toBe(true);
    });

    it("should return true when Twitter OAuth2 client env var is set", () => {
      delete process.env.TWITTER_API_KEY;
      delete process.env.TWITTER_API_SECRET_KEY;
      process.env.TWITTER_CLIENT_ID = "test-client-id";

      const twitter = OAUTH_PROVIDERS.twitter;
      expect(isProviderConfigured(twitter)).toBe(true);
    });
  });

  describe("getConfiguredProviders", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should always include API key providers", () => {
      // Clear all OAuth env vars
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.TWITTER_API_KEY;
      delete process.env.TWITTER_API_SECRET_KEY;
      delete process.env.TWITTER_CLIENT_ID;

      const configured = getConfiguredProviders();
      const ids = configured.map((p) => p.id);

      expect(ids).toContain("twilio");
      expect(ids).toContain("blooio");
    });

    it("should include OAuth providers when configured", () => {
      process.env.GOOGLE_CLIENT_ID = "test-id";
      process.env.GOOGLE_CLIENT_SECRET = "test-secret";

      const configured = getConfiguredProviders();
      const ids = configured.map((p) => p.id);

      expect(ids).toContain("google");
    });

    it("should not include OAuth providers when not configured", () => {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.TWITTER_API_KEY;
      delete process.env.TWITTER_API_SECRET_KEY;
      delete process.env.TWITTER_CLIENT_ID;

      const configured = getConfiguredProviders();
      const ids = configured.map((p) => p.id);

      expect(ids).not.toContain("google");
      expect(ids).not.toContain("twitter");
    });
  });

  describe("getAllProviderIds", () => {
    it("should return all provider IDs", () => {
      const ids = getAllProviderIds();

      expect(ids).toContain("google");
      expect(ids).toContain("twitter");
      expect(ids).toContain("twilio");
      expect(ids).toContain("blooio");
    });

    it("should not include Discord", () => {
      const ids = getAllProviderIds();
      expect(ids).not.toContain("discord");
    });

    it("should match keys of OAUTH_PROVIDERS", () => {
      const ids = getAllProviderIds();
      const providerKeys = Object.keys(OAUTH_PROVIDERS);

      expect(ids.sort()).toEqual(providerKeys.sort());
    });
  });

  describe("isValidProvider", () => {
    it("should return true for valid provider IDs", () => {
      const validIds = ["google", "twitter", "twilio", "blooio"];

      for (const id of validIds) {
        expect(isValidProvider(id)).toBe(true);
      }
    });

    it("should return false for invalid provider IDs", () => {
      const invalidIds = ["discord", "invalid", ""];

      for (const id of invalidIds) {
        expect(isValidProvider(id)).toBe(false);
      }
    });

    it("should be case-insensitive", () => {
      expect(isValidProvider("google")).toBe(true);
      expect(isValidProvider("Google")).toBe(true);
      expect(isValidProvider("GOOGLE")).toBe(true);
    });
  });
});
