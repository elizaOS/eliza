/**
 * Cron Auth Integration Tests
 *
 * Tests verifyCronSecret() with realistic Request objects
 * to validate the full auth flow including response body parsing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { verifyCronSecret } from "@/lib/auth/cron";

const TEST_SECRET = "integration-test-cron-secret-abc123";

function makeRequest(headers: Record<string, string> = {}): Request {
  const h = new Headers(headers);
  h.set("x-forwarded-for", "10.0.0.1");
  return new Request("http://localhost:3000/api/v1/cron/health-check", {
    method: "GET",
    headers: h,
  });
}

describe("Cron Auth Integration", () => {
  const ORIGINAL = process.env.CRON_SECRET;

  afterEach(() => {
    if (ORIGINAL !== undefined) {
      process.env.CRON_SECRET = ORIGINAL;
    } else {
      delete process.env.CRON_SECRET;
    }
  });

  // =========================================================================
  // Full lifecycle: valid secret → success
  // =========================================================================

  describe("valid secret", () => {
    beforeEach(() => {
      process.env.CRON_SECRET = TEST_SECRET;
    });

    it("returns null for valid secret", () => {
      const req = makeRequest({ authorization: `Bearer ${TEST_SECRET}` });
      expect(verifyCronSecret(req, "[Integration]")).toBeNull();
    });

    it("works with custom log prefix", () => {
      const req = makeRequest({ authorization: `Bearer ${TEST_SECRET}` });
      expect(verifyCronSecret(req, "[Custom Prefix]")).toBeNull();
    });

    it("works with default log prefix", () => {
      const req = makeRequest({ authorization: `Bearer ${TEST_SECRET}` });
      expect(verifyCronSecret(req)).toBeNull();
    });
  });

  // =========================================================================
  // Missing CRON_SECRET → 503 with correct body
  // =========================================================================

  describe("missing CRON_SECRET", () => {
    beforeEach(() => {
      delete process.env.CRON_SECRET;
    });

    it("returns 503 Response with error body", async () => {
      const req = makeRequest({ authorization: `Bearer ${TEST_SECRET}` });
      const result = verifyCronSecret(req, "[Integration]");

      expect(result).not.toBeNull();
      expect(result!.status).toBe(503);

      const body = (await result!.json()) as { error: string };
      expect(body.error).toContain("CRON_SECRET");
    });
  });

  // =========================================================================
  // Wrong secret → 401 with correct body
  // =========================================================================

  describe("wrong secret", () => {
    beforeEach(() => {
      process.env.CRON_SECRET = TEST_SECRET;
    });

    it("returns 401 Response with Unauthorized body", async () => {
      const req = makeRequest({ authorization: "Bearer wrong" });
      const result = verifyCronSecret(req, "[Integration]");

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);

      const body = (await result!.json()) as { error: string };
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 401 for empty Bearer token", async () => {
      const req = makeRequest({ authorization: "Bearer " });
      const result = verifyCronSecret(req, "[Integration]");

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it("returns 401 when Authorization header is completely missing", async () => {
      const req = makeRequest(); // no authorization header
      const result = verifyCronSecret(req, "[Integration]");

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });
  });

  // =========================================================================
  // Timing safety — no length-based shortcuts
  // =========================================================================

  describe("timing safety", () => {
    beforeEach(() => {
      process.env.CRON_SECRET = TEST_SECRET;
    });

    it("rejects secrets of different lengths", () => {
      const req = makeRequest({ authorization: "Bearer short" });
      const result = verifyCronSecret(req, "[Integration]");
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it("rejects secrets with matching prefix but different suffix", () => {
      const almostRight = TEST_SECRET.slice(0, -1) + "X";
      const req = makeRequest({ authorization: `Bearer ${almostRight}` });
      const result = verifyCronSecret(req, "[Integration]");
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });
  });
});
