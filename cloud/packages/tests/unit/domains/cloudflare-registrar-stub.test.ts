/**
 * Unit tests for cloudflare-registrar stub-mode behavior.
 *
 * The real-network paths are validated against the actual cloudflare API in
 * staging/manual tests. These tests verify the deterministic stub responses
 * the rest of our buy-flow tests depend on.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { CloudflareApiError } from "@/lib/utils/cloudflare-api";

beforeAll(() => {
  process.env.ELIZA_CF_REGISTRAR_DEV_STUB = "1";
});

describe("cloudflareRegistrarService (stub mode)", () => {
  test("normalizeRegistrationStatus tolerates missing cloudflare status fields", async () => {
    const { normalizeRegistrationStatus } = await import("@/lib/services/cloudflare-registrar");
    expect(normalizeRegistrationStatus(undefined)).toBe("pending");
    expect(normalizeRegistrationStatus(null)).toBe("pending");
    expect(normalizeRegistrationStatus("registered")).toBe("active");
    expect(normalizeRegistrationStatus("cancelled")).toBe("failed");
  });

  test("checkAvailability returns available + canonical price", async () => {
    const { cloudflareRegistrarService } = await import("@/lib/services/cloudflare-registrar");
    const r = await cloudflareRegistrarService.checkAvailability("myapp.com");
    expect(r.available).toBe(true);
    expect(r.priceUsdCents).toBe(1099);
    expect(r.currency).toBe("USD");
    expect(r.years).toBe(1);
  });

  test("checkAvailability returns unavailable for taken-* prefix", async () => {
    const { cloudflareRegistrarService } = await import("@/lib/services/cloudflare-registrar");
    const r = await cloudflareRegistrarService.checkAvailability("taken-myapp.com");
    expect(r.available).toBe(false);
  });

  test("registerDomain returns pending registration", async () => {
    const { cloudflareRegistrarService } = await import("@/lib/services/cloudflare-registrar");
    const r = await cloudflareRegistrarService.registerDomain("myapp.com");
    expect(r.registrationId).toBe("stub-reg-myapp.com");
    expect(r.status).toBe("pending");
  });

  test("registerDomain throws CloudflareApiError for fail-* prefix", async () => {
    const { cloudflareRegistrarService } = await import("@/lib/services/cloudflare-registrar");
    await expect(cloudflareRegistrarService.registerDomain("fail-test.com")).rejects.toBeInstanceOf(
      CloudflareApiError,
    );
  });

  test("getRegistrationStatus returns active for stub", async () => {
    const { cloudflareRegistrarService } = await import("@/lib/services/cloudflare-registrar");
    const r = await cloudflareRegistrarService.getRegistrationStatus("myapp.com");
    expect(r.status).toBe("active");
    expect(r.completedAt).toBeTruthy();
    expect(r.failureReason).toBeNull();
  });

  test("getRegisteredDomain returns zone id", async () => {
    const { cloudflareRegistrarService } = await import("@/lib/services/cloudflare-registrar");
    const r = await cloudflareRegistrarService.getRegisteredDomain("myapp.com");
    expect(r.zoneId).toBe("stub-zone-myapp.com");
    expect(r.autoRenew).toBe(true);
  });
});

describe("cloudflare-registrar stub: search + batch", () => {
  test("checkAvailabilities returns one entry per input", async () => {
    const reg = await import(
      `../../../lib/services/cloudflare-registrar.ts?stub_batch=${Date.now()}`
    );
    const out = await reg.cloudflareRegistrarService.checkAvailabilities([
      "foo.com",
      "taken-bar.com",
      "baz.dev",
    ]);
    expect(out.length).toBe(3);
    expect(out[0].available).toBe(true);
    expect(out[1].available).toBe(false);
    expect(out[2].available).toBe(true);
  });

  test("checkAvailabilities throws when more than 20 domains", async () => {
    const reg = await import(
      `../../../lib/services/cloudflare-registrar.ts?stub_batch_over=${Date.now()}`
    );
    const tooMany = Array.from({ length: 21 }, (_, i) => `d${i}.com`);
    await expect(reg.cloudflareRegistrarService.checkAvailabilities(tooMany)).rejects.toThrow();
  });

  test("checkAvailabilities([]) returns empty without calling CF", async () => {
    const reg = await import(
      `../../../lib/services/cloudflare-registrar.ts?stub_batch_empty=${Date.now()}`
    );
    const out = await reg.cloudflareRegistrarService.checkAvailabilities([]);
    expect(out).toEqual([]);
  });

  test("searchDomains returns candidates with prices", async () => {
    const reg = await import(
      `../../../lib/services/cloudflare-registrar.ts?stub_search=${Date.now()}`
    );
    const out = await reg.cloudflareRegistrarService.searchDomains("acme", 5);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].priceUsdCents).toBeGreaterThan(0);
  });
});

describe("cloudflareRegistrarService (Cloudflare API response shape)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.ELIZA_CF_REGISTRAR_DEV_STUB = "0";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct_123";
    process.env.CLOUDFLARE_API_TOKEN = "token_123";

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/accounts/acct_123/registrar/registrations")) {
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            domain_name: "myapp.dev",
            state: "succeeded",
            updated_at: "2026-05-04T22:00:00Z",
            context: {
              registration: {
                domain_name: "myapp.dev",
                status: "active",
                expires_at: "2027-05-04T22:00:00Z",
                auto_renew: false,
              },
            },
          },
        });
      }

      if (url.includes("/registrar/registrations/myapp.dev/registration-status")) {
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            domain_name: "myapp.dev",
            state: "failed",
            updated_at: "2026-05-04T22:01:00Z",
            error: { code: "registry_error", message: "registry rejected registration" },
          },
        });
      }

      if (url.includes("/registrar/registrations/myapp.dev")) {
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            domain_name: "myapp.dev",
            status: "active",
            expires_at: "2027-05-04T22:00:00Z",
            auto_renew: false,
          },
        });
      }

      if (url.includes("/zones?")) {
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: [{ id: "zone_123", name: "myapp.dev" }],
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.ELIZA_CF_REGISTRAR_DEV_STUB = "1";
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
  });

  test("registerDomain parses the beta workflow response", async () => {
    const reg = await import(
      `../../../lib/services/cloudflare-registrar.ts?api_register=${Date.now()}`
    );
    const result = await reg.cloudflareRegistrarService.registerDomain("myapp.dev");
    expect(result.domain).toBe("myapp.dev");
    expect(result.registrationId).toBe("myapp.dev");
    expect(result.status).toBe("active");
  });

  test("getRegisteredDomain uses registration resource plus zone lookup", async () => {
    const reg = await import(
      `../../../lib/services/cloudflare-registrar.ts?api_domain=${Date.now()}`
    );
    const result = await reg.cloudflareRegistrarService.getRegisteredDomain("myapp.dev");
    expect(result.domain).toBe("myapp.dev");
    expect(result.zoneId).toBe("zone_123");
    expect(result.expiresAt).toBe("2027-05-04T22:00:00Z");
    expect(result.autoRenew).toBe(false);
  });

  test("getRegistrationStatus surfaces workflow failures", async () => {
    const reg = await import(
      `../../../lib/services/cloudflare-registrar.ts?api_status=${Date.now()}`
    );
    const result = await reg.cloudflareRegistrarService.getRegistrationStatus("myapp.dev");
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("registry rejected registration");
    expect(result.completedAt).toBe("2026-05-04T22:01:00Z");
  });
});
