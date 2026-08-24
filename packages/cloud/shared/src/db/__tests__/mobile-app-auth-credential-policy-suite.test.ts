/**
 * Unit tests for mobile app auth credential provenance policy.
 * Validates canonical credential naming, description formatting, and composite provenance builders.
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
    it("defines canonical prefixes", () => {
      expect(MOBILE_APP_AUTH_CREDENTIAL_NAME_PREFIX).toBe("Eliza mobile");
      expect(MOBILE_APP_AUTH_CREDENTIAL_DESCRIPTION_PREFIX).toBe("First-party mobile credential");
    });
  });

  describe("buildMobileAppAuthCredentialName", () => {
    it("includes deviceName when present", () => {
      const name = buildMobileAppAuthCredentialName({
        deviceName: "iPhone 16 Pro",
        environment: "production",
        grantId: "grant-uuid-1234",
      });
      expect(name).toBe("Eliza mobile - iPhone 16 Pro - production - grant-uuid-1234");
    });

    it("omits deviceName when null or undefined", () => {
      const name = buildMobileAppAuthCredentialName({
        deviceName: null,
        environment: "staging",
        grantId: "grant-uuid-5678",
      });
      expect(name).toBe("Eliza mobile - staging - grant-uuid-5678");
    });
  });

  describe("buildMobileAppAuthCredentialDescription", () => {
    it("formats client ID and space-separated scopes", () => {
      const desc = buildMobileAppAuthCredentialDescription({
        clientId: "mobile-app-client",
        scopes: ["offline_access", "read:agents", "write:messages"],
      });
      expect(desc).toBe(
        "First-party mobile credential; client=mobile-app-client; scope=offline_access read:agents write:messages",
      );
    });
  });

  describe("buildMobileAppAuthCredentialProvenance", () => {
    it("builds composite name and description bundle", () => {
      const prov = buildMobileAppAuthCredentialProvenance({
        deviceName: "Pixel 9",
        environment: "production",
        grantId: "grant-001",
        clientId: "client-android",
        scopes: ["read", "write"],
      });
      expect(prov).toEqual({
        name: "Eliza mobile - Pixel 9 - production - grant-001",
        description: "First-party mobile credential; client=client-android; scope=read write",
      });
    });
  });
});
