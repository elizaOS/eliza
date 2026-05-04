/**
 * OAuth State Validation Tests
 *
 * Tests for OAuth state schema validation and security.
 * Verifies that the Zod schema properly validates state objects.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";

// Recreate the schema used in the Google callback route for testing
const OAuthStateSchema = z.object({
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
  redirectUrl: z.string(),
  scopes: z.array(z.string()),
});

describe("OAuth State Schema Validation", () => {
  describe("Valid State Objects", () => {
    it("validates correct state object", () => {
      const validState = {
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        redirectUrl: "/dashboard/settings?tab=connections",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      };

      expect(() => OAuthStateSchema.parse(validState)).not.toThrow();
    });

    it("validates state with multiple scopes", () => {
      const validState = {
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        redirectUrl: "/dashboard",
        scopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/calendar.events",
        ],
      };

      expect(() => OAuthStateSchema.parse(validState)).not.toThrow();
    });

    it("validates state with empty scopes array", () => {
      const validState = {
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        redirectUrl: "/dashboard",
        scopes: [],
      };

      expect(() => OAuthStateSchema.parse(validState)).not.toThrow();
    });
  });

  describe("Invalid State Objects", () => {
    it("rejects state with invalid organizationId", () => {
      const invalidState = {
        organizationId: "not-a-uuid",
        userId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        redirectUrl: "/dashboard",
        scopes: [],
      };

      expect(() => OAuthStateSchema.parse(invalidState)).toThrow();
    });

    it("rejects state with invalid userId", () => {
      const invalidState = {
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "invalid-user-id",
        redirectUrl: "/dashboard",
        scopes: [],
      };

      expect(() => OAuthStateSchema.parse(invalidState)).toThrow();
    });

    it("rejects state with missing required fields", () => {
      const incompleteState = {
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        // Missing userId, redirectUrl, scopes
      };

      expect(() => OAuthStateSchema.parse(incompleteState)).toThrow();
    });

    it("rejects state with wrong field types", () => {
      const wrongTypes = {
        organizationId: 12345, // Should be string
        userId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        redirectUrl: "/dashboard",
        scopes: "not-an-array", // Should be array
      };

      expect(() => OAuthStateSchema.parse(wrongTypes)).toThrow();
    });

    it("rejects null input", () => {
      expect(() => OAuthStateSchema.parse(null)).toThrow();
    });

    it("rejects undefined input", () => {
      expect(() => OAuthStateSchema.parse(undefined)).toThrow();
    });

    it("rejects non-string scopes", () => {
      const invalidScopes = {
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        redirectUrl: "/dashboard",
        scopes: [1, 2, 3], // Should be strings
      };

      expect(() => OAuthStateSchema.parse(invalidScopes)).toThrow();
    });
  });

  describe("Security Edge Cases", () => {
    it("rejects prototype pollution attempts", () => {
      const protoAttempt = {
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        redirectUrl: "/dashboard",
        scopes: [],
        __proto__: { isAdmin: true },
      };

      // Zod strips unknown properties, so this should pass but without __proto__
      const result = OAuthStateSchema.parse(protoAttempt) as Record<string, unknown>;
      expect(Object.hasOwn(result, "__proto__")).toBe(false);
      expect(Object.hasOwn(result, "isAdmin")).toBe(false);
    });

    it("handles deeply nested malicious objects", () => {
      const maliciousState = {
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        userId: {
          nested: {
            attack: true,
          },
        },
        redirectUrl: "/dashboard",
        scopes: [],
      };

      expect(() => OAuthStateSchema.parse(maliciousState)).toThrow();
    });

    it("handles extra fields gracefully (strips them)", () => {
      const stateWithExtra = {
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        redirectUrl: "/dashboard",
        scopes: [],
        extraField: "malicious",
        anotherField: { nested: true },
      };

      const result = OAuthStateSchema.parse(stateWithExtra);
      expect(result).not.toHaveProperty("extraField");
      expect(result).not.toHaveProperty("anotherField");
    });

    it("validates UUID format strictly", () => {
      // Almost valid but wrong format
      const almostValidUUID = {
        organizationId: "550e8400e29b41d4a716446655440000", // Missing dashes
        userId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        redirectUrl: "/dashboard",
        scopes: [],
      };

      expect(() => OAuthStateSchema.parse(almostValidUUID)).toThrow();
    });
  });

  describe("JSON Parsing Integration", () => {
    it("validates JSON parsed state correctly", () => {
      const jsonState = JSON.stringify({
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        redirectUrl: "/dashboard/settings?tab=connections",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      });

      const parsed = JSON.parse(jsonState);
      expect(() => OAuthStateSchema.parse(parsed)).not.toThrow();
    });

    it("handles malformed JSON gracefully", () => {
      const malformedJSON = '{"organizationId": "test"'; // Incomplete JSON

      expect(() => {
        const parsed = JSON.parse(malformedJSON);
        OAuthStateSchema.parse(parsed);
      }).toThrow();
    });
  });
});
