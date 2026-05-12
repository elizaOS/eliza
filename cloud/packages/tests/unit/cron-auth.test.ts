/**
 * Cron Auth Utility Tests
 *
 * Tests for the verifyCronSecret() shared utility.
 * Validates fail-closed behavior, timing-safe comparison,
 * and proper error responses.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { verifyCronSecret } from "@/lib/auth/cron";

/** Helper to create a mock Request with optional Authorization header */
function mockRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader) {
    headers.set("authorization", authHeader);
  }
  headers.set("x-forwarded-for", "127.0.0.1");

  return new Request("http://localhost:3000/api/cron/test", {
    method: "POST",
    headers,
  });
}

describe("verifyCronSecret", () => {
  const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

  afterEach(() => {
    // Restore original value
    if (ORIGINAL_CRON_SECRET !== undefined) {
      process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    } else {
      delete process.env.CRON_SECRET;
    }
  });

  // =========================================================================
  // Fail-closed: CRON_SECRET not configured
  // =========================================================================

  describe("when CRON_SECRET is not configured", () => {
    beforeEach(() => {
      delete process.env.CRON_SECRET;
    });

    it("returns 503 response", () => {
      const request = mockRequest("Bearer some-secret");
      const result = verifyCronSecret(request, "[Test]");

      expect(result).not.toBeNull();
      expect(result!.status).toBe(503);
    });

    it("returns error message about configuration", async () => {
      const request = mockRequest("Bearer some-secret");
      const result = verifyCronSecret(request, "[Test]");

      const body = (await result!.json()) as { error: string };
      expect(body.error).toContain("CRON_SECRET not set");
    });
  });

  // =========================================================================
  // Auth failures
  // =========================================================================

  describe("when CRON_SECRET is configured", () => {
    const TEST_SECRET = "test-cron-secret-12345";

    beforeEach(() => {
      process.env.CRON_SECRET = TEST_SECRET;
    });

    it("returns 401 when no Authorization header is provided", () => {
      const request = mockRequest(); // no auth header
      const result = verifyCronSecret(request, "[Test]");

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it("returns 401 for wrong secret", () => {
      const request = mockRequest("Bearer wrong-secret");
      const result = verifyCronSecret(request, "[Test]");

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it("returns 401 for empty Bearer token", () => {
      const request = mockRequest("Bearer ");
      const result = verifyCronSecret(request, "[Test]");

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it("returns null (success) even without Bearer prefix", () => {
      // The function uses .replace('Bearer ', '') which is a no-op if
      // the prefix isn't present, so the raw secret passes through
      const request = mockRequest(TEST_SECRET);
      const result = verifyCronSecret(request, "[Test]");

      // This succeeds because the raw secret matches CRON_SECRET
      expect(result).toBeNull();
    });

    it("returns 401 for partial match secret", () => {
      const request = mockRequest(`Bearer ${TEST_SECRET.slice(0, -2)}`);
      const result = verifyCronSecret(request, "[Test]");

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it("returns 401 for secret with extra characters", () => {
      const request = mockRequest(`Bearer ${TEST_SECRET}extra`);
      const result = verifyCronSecret(request, "[Test]");

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    // =========================================================================
    // Success case
    // =========================================================================

    it("returns null (success) for valid secret", () => {
      const request = mockRequest(`Bearer ${TEST_SECRET}`);
      const result = verifyCronSecret(request, "[Test]");

      expect(result).toBeNull();
    });

    it("accepts valid secret with various log prefixes", () => {
      const prefixes = ["[AgentBudgets Cron]", "[Health Check Cron]", "[Test]", ""];

      for (const prefix of prefixes) {
        const request = mockRequest(`Bearer ${TEST_SECRET}`);
        const result = verifyCronSecret(request, prefix);
        expect(result).toBeNull();
      }
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("handles long secrets", () => {
      const longSecret = "a".repeat(512);
      process.env.CRON_SECRET = longSecret;
      const request = mockRequest(`Bearer ${longSecret}`);
      const result = verifyCronSecret(request, "[Test]");
      expect(result).toBeNull();
    });

    it("rejects empty string as CRON_SECRET", () => {
      process.env.CRON_SECRET = "";
      // Empty string is falsy, so it should be treated as "not configured"
      const request = mockRequest("Bearer ");
      const result = verifyCronSecret(request, "[Test]");
      expect(result).not.toBeNull();
      expect(result!.status).toBe(503);
    });
  });
});
