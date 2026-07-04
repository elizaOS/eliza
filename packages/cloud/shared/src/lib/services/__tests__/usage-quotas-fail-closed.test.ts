/**
 * Service-seam coverage for usage-quota rows that gate metered spend.
 *
 * Corrupt quota values must throw instead of granting quota, while healthy rows
 * still allow or deny by their configured limits.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const findByOrganizationAndType = mock();
const findActiveByOrganization = mock();

mock.module("../../../db/repositories", () => ({
  usageQuotasRepository: {
    findByOrganizationAndType,
    findActiveByOrganization,
  },
}));

const { usageQuotasService } = await import("../usage-quotas");

function healthyQuota(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "22222222-2222-4222-8222-222222222222",
    quota_type: "global",
    model_name: null,
    period_type: "weekly",
    credits_limit: "100.00",
    current_usage: "10.00",
    period_start: new Date("2026-07-01T00:00:00Z"),
    period_end: new Date("2026-07-08T00:00:00Z"),
    is_active: true,
    ...overrides,
  };
}

beforeEach(() => {
  findByOrganizationAndType.mockReset();
  findActiveByOrganization.mockReset();
});

describe("UsageQuotasService.checkQuota fail-closed", () => {
  test("allows when a healthy global quota has headroom", async () => {
    findByOrganizationAndType.mockResolvedValue(healthyQuota());
    const result = await usageQuotasService.checkQuota("org", 5);
    expect(result.allowed).toBe(true);
  });

  test("denies when a healthy global quota is exceeded", async () => {
    findByOrganizationAndType.mockResolvedValue(
      healthyQuota({ credits_limit: "100.00", current_usage: "99.00" }),
    );
    const result = await usageQuotasService.checkQuota("org", 5);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/quota exceeded/i);
  });

  test("THROWS (fails closed) instead of allowing when the global limit is corrupt", async () => {
    findByOrganizationAndType.mockResolvedValue(
      healthyQuota({ credits_limit: "corrupt", current_usage: "10.00" }),
    );
    await expect(usageQuotasService.checkQuota("org", 5)).rejects.toThrow(
      /Unable to read extra usage credits_limit/,
    );
  });

  test("THROWS (fails closed) instead of allowing when the model limit is corrupt", async () => {
    findByOrganizationAndType.mockImplementation(async (_org: string, quotaType: string) =>
      quotaType === "model_specific"
        ? healthyQuota({
            quota_type: "model_specific",
            model_name: "gpt",
            credits_limit: "",
            current_usage: "10.00",
          })
        : undefined,
    );
    await expect(usageQuotasService.checkQuota("org", 5, "gpt")).rejects.toThrow(
      /Unable to read extra usage/,
    );
  });

  test("no quota rows -> allowed (no quota configured is not a corrupt read)", async () => {
    findByOrganizationAndType.mockResolvedValue(undefined);
    const result = await usageQuotasService.checkQuota("org", 5);
    expect(result.allowed).toBe(true);
  });
});

describe("UsageQuotasService.getCurrentUsage fail-closed", () => {
  test("THROWS on a corrupt current_usage instead of reporting NaN", async () => {
    findActiveByOrganization.mockResolvedValue([healthyQuota({ current_usage: "corrupt" })]);
    let caught: unknown;
    try {
      await usageQuotasService.getCurrentUsage("org");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Unable to read extra usage current_usage");
  });

  test("returns a healthy usage breakdown for well-formed rows", async () => {
    findActiveByOrganization.mockResolvedValue([
      healthyQuota({ current_usage: "25.00", credits_limit: "100.00" }),
    ]);
    const result = await usageQuotasService.getCurrentUsage("org");
    expect(result.global.used).toBe(25);
    expect(result.global.limit).toBe(100);
  });
});
