import { beforeAll, describe, expect, it } from "vitest";
import { XAuth } from "../auth";
import type { XOAuth1Provider } from "../auth-providers/types";

/**
 * Integration tests for XAuth using real X API credentials.
 * Requires environment variables:
 * - X_API_KEY (app key)
 * - X_API_SECRET (app secret)
 * - X_ACCESS_TOKEN
 * - X_ACCESS_SECRET
 */

const hasCredentials =
  process.env.X_API_KEY &&
  process.env.X_API_SECRET &&
  process.env.X_ACCESS_TOKEN &&
  process.env.X_ACCESS_SECRET;

const describeWithCredentials = hasCredentials ? describe : describe.skip;

if (!hasCredentials) {
  console.warn(
    "⚠️  Skipping XAuth integration tests: missing X API credentials. " +
      "Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET to run these tests."
  );
}

describeWithCredentials("XAuth (integration)", () => {
  let auth: XAuth;

  beforeAll(() => {
    const provider: XOAuth1Provider = {
      mode: "env",
      getAccessToken: async () => process.env.X_ACCESS_TOKEN!,
      getOAuth1Credentials: async () => ({
        appKey: process.env.X_API_KEY!,
        appSecret: process.env.X_API_SECRET!,
        accessToken: process.env.X_ACCESS_TOKEN!,
        accessSecret: process.env.X_ACCESS_SECRET!,
      }),
    };
    auth = new XAuth(provider);
  });

  describe("getV2Client", () => {
    it("should return a valid X API v2 client", async () => {
      const client = await auth.getV2Client();
      expect(client).toBeDefined();
      expect(client.v2).toBeDefined();
    });
  });

  describe("isLoggedIn", () => {
    it("should return true when authenticated with valid credentials", async () => {
      const isLoggedIn = await auth.isLoggedIn();
      expect(isLoggedIn).toBe(true);
    });
  });

  describe("me", () => {
    it("should return the authenticated user profile", async () => {
      const profile = await auth.me();

      expect(profile).toBeDefined();
      expect(profile?.userId).toBeDefined();
      expect(profile?.username).toBeDefined();
      expect(profile?.name).toBeDefined();
    });

    it("should cache profile after first fetch", async () => {
      const profile1 = await auth.me();
      const profile2 = await auth.me();

      // Same reference means it was cached
      expect(profile1).toBe(profile2);
    });
  });

  describe("hasToken", () => {
    it("should return true when authenticated", () => {
      expect(auth.hasToken()).toBe(true);
    });
  });

  describe("logout", () => {
    it("should clear credentials and profile", async () => {
      // Create a separate auth instance for this test to not affect others
      const logoutProvider: XOAuth1Provider = {
        mode: "env",
        getAccessToken: async () => process.env.X_ACCESS_TOKEN!,
        getOAuth1Credentials: async () => ({
          appKey: process.env.X_API_KEY!,
          appSecret: process.env.X_API_SECRET!,
          accessToken: process.env.X_ACCESS_TOKEN!,
          accessSecret: process.env.X_ACCESS_SECRET!,
        }),
      };
      const logoutAuth = new XAuth(logoutProvider);

      // First ensure we're logged in
      await logoutAuth.me();
      expect(logoutAuth.hasToken()).toBe(true);

      // Then logout
      await logoutAuth.logout();

      // Verify logged out state
      expect(logoutAuth.hasToken()).toBe(false);
      await expect(logoutAuth.getV2Client()).rejects.toThrow("X API client not initialized");
    });
  });
});
