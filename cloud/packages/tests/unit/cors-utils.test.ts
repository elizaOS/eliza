/**
 * CORS Utility Tests
 *
 * Tests for getCorsHeaders() to validate origin allowlist behavior.
 */

import { describe, expect, it } from "bun:test";
import { getCorsHeaders } from "@/lib/utils/cors";

describe("getCorsHeaders", () => {
  // =========================================================================
  // Allowed origins
  // =========================================================================

  describe("allowed origins", () => {
    it("reflects allowed origin in Access-Control-Allow-Origin", () => {
      // The ALLOWED_ORIGINS list includes process.env.NEXT_PUBLIC_APP_URL
      // and the Agent production domains. In test env, NEXT_PUBLIC_APP_URL may not be set,
      // so we test with the hardcoded allowed origins.
      const headers = getCorsHeaders("https://eliza.ai");
      expect(headers["Access-Control-Allow-Origin"]).toBe("https://eliza.ai");
    });

    it("reflects www subdomain as allowed origin", () => {
      const headers = getCorsHeaders("https://www.eliza.ai");
      expect(headers["Access-Control-Allow-Origin"]).toBe("https://www.eliza.ai");
    });

    it("reflects the Eliza homepage origin", () => {
      const headers = getCorsHeaders("https://eliza.ai");
      expect(headers["Access-Control-Allow-Origin"]).toBe("https://eliza.ai");
    });

    it("sets Access-Control-Allow-Credentials for allowed origins", () => {
      const headers = getCorsHeaders("https://eliza.app");
      expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    });
  });

  // =========================================================================
  // Disallowed origins
  // =========================================================================

  describe("disallowed origins", () => {
    it("omits Access-Control-Allow-Origin for unknown origin", () => {
      const headers = getCorsHeaders("https://evil.example.com");
      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("omits credentials header for unknown origin", () => {
      const headers = getCorsHeaders("https://evil.example.com");
      expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
    });

    it("omits Access-Control-Allow-Origin for null origin", () => {
      const headers = getCorsHeaders(null);
      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("omits Access-Control-Allow-Origin for empty string", () => {
      const headers = getCorsHeaders("");
      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });
  });

  // =========================================================================
  // Common headers (always present)
  // =========================================================================

  describe("common headers", () => {
    it("always includes Access-Control-Allow-Methods", () => {
      const headers1 = getCorsHeaders("https://eliza.ai");
      const headers2 = getCorsHeaders("https://evil.com");
      const headers3 = getCorsHeaders(null);

      for (const headers of [headers1, headers2, headers3]) {
        expect(headers["Access-Control-Allow-Methods"]).toBeDefined();
        expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
        expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
      }
    });

    it("always includes Access-Control-Allow-Headers", () => {
      const headers = getCorsHeaders(null);
      expect(headers["Access-Control-Allow-Headers"]).toBeDefined();
      expect(headers["Access-Control-Allow-Headers"]).toContain("X-API-Key");
      expect(headers["Access-Control-Allow-Headers"]).toContain("Authorization");
      expect(headers["Access-Control-Allow-Headers"]).toContain("Content-Type");
    });

    it("sets Access-Control-Max-Age", () => {
      const headers = getCorsHeaders(null);
      expect(headers["Access-Control-Max-Age"]).toBe("86400");
    });
  });
});
