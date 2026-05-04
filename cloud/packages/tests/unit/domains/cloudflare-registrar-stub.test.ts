/**
 * Unit tests for cloudflare-registrar stub-mode behavior.
 *
 * The real-network paths are validated against the actual cloudflare API in
 * staging/manual tests. These tests verify the deterministic stub responses
 * the rest of our buy-flow tests depend on.
 */

import { beforeAll, describe, expect, test } from "bun:test";
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
