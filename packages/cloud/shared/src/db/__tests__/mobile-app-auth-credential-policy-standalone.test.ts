/**
 * Unit tests for mobile app auth credential provenance policy.
 * Validates canonical credential naming, description formats, and provenance structure.
 */
import { describe, expect, it } from "vitest";
import {
  buildMobileAppAuthCredentialDescription,
  buildMobileAppAuthCredentialName,
  buildMobileAppAuthCredentialProvenance,
  MOBILE_APP_AUTH_CREDENTIAL_DESCRIPTION_PREFIX,
  MOBILE_APP_AUTH_CREDENTIAL_NAME_PREFIX,
} from "../mobile-app-auth-credential-policy.ts";

describe("mobile-app-auth-credential-policy", () => {
  describe("constants", () => {
    it("exports canonical name and description prefixes", () => {
      expect(MOBILE_APP_AUTH_CREDENTIAL_NAME_PREFIX).toBe("Eliza mobile");
      expect(MOBILE_APP_AUTH_CREDENTIAL_DESCRIPTION_PREFIX).toBe("First-party mobile credential");
    });
  });

  describe("buildMobileAppAuthCredentialName", () => {
    it("formats name with deviceName when provided", () => {
      const name = buildMobileAppAuthCredentialName({
        deviceName: "iPhone 15 Pro",
        environment: "production",
        grantId: "grant_12345",
      });
      expect(name).toBe("Eliza mobile - iPhone 15 Pro - production - grant_12345");
    });

    it("formats name without deviceName segment when deviceName is undefined or null", () => {
      const nameWithoutDevice = buildMobileAppAuthCredentialName({
        environment: "staging",
        grantId: "grant_67890",
      });
      expect(nameWithoutDevice).toBe("Eliza mobile - staging - grant_67890");

      const nameWithNullDevice = buildMobileAppAuthCredentialName({
        deviceName: null,
        environment: "development",
        grantId: "grant_abc",
      });
      expect(nameWithNullDevice).toBe("Eliza mobile - development - grant_abc");
    });
  });

  describe("buildMobileAppAuthCredentialDescription", () => {
    it("formats description with client ID and space-separated scopes", () => {
      const desc = buildMobileAppAuthCredentialDescription({
        clientId: "eliza-ios-app",
        scopes: ["read:agents", "write:messages", "admin:all"],
      });
      expect(desc).toBe(
        "First-party mobile credential; client=eliza-ios-app; scope=read:agents write:messages admin:all",
      );
    });

    it("handles empty scope list", () => {
      const desc = buildMobileAppAuthCredentialDescription({
        clientId: "eliza-android-app",
        scopes: [],
      });
      expect(desc).toBe("First-party mobile credential; client=eliza-android-app; scope=");
    });
  });

  describe("buildMobileAppAuthCredentialProvenance", () => {
    it("returns combined name and description object", () => {
      const provenance = buildMobileAppAuthCredentialProvenance({
        grantId: "grant_full_001",
        environment: "production",
        deviceName: "Pixel 9",
        clientId: "eliza-mobile-core",
        scopes: ["offline_access", "openid"],
      });
      expect(provenance).toEqual({
        name: "Eliza mobile - Pixel 9 - production - grant_full_001",
        description:
          "First-party mobile credential; client=eliza-mobile-core; scope=offline_access openid",
      });
    });
  });
});
