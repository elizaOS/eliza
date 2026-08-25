/**
 * Exercises billing-settings corruption responses and method-specific rate
 * limits without loading Stripe, Redis, or a database.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000207";
const STANDARD_RATE_LIMIT = { windowMs: 60_000, maxRequests: 100 } as const;
const rateLimitConfigs: Array<Record<string, unknown>> = [];

class AutoTopUpSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoTopUpSettingsValidationError";
  }
}

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-20717",
  organization_id: ORGANIZATION_ID,
}));
const getSettings = mock(async () => ({
  enabled: false,
  amount: null,
  threshold: null,
  hasPaymentMethod: true,
}));
const updateSettings = mock(async () => undefined);
const findOrganizationById = mock(async () => ({
  id: ORGANIZATION_ID,
  pay_as_you_go_from_earnings: false,
}));
const updateOrganization = mock(async () => undefined);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/db/repositories", () => ({
  organizationsRepository: {
    findById: findOrganizationById,
    update: updateOrganization,
  },
}));

mock.module("@/lib/services/auto-top-up", () => ({
  AUTO_TOP_UP_LIMITS: {
    MIN_AMOUNT: 1,
    MAX_AMOUNT: 1000,
    MIN_THRESHOLD: 0,
    MAX_THRESHOLD: 1000,
  },
  AutoTopUpSettingsValidationError,
  autoTopUpService: { getSettings, updateSettings },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: STANDARD_RATE_LIMIT },
  rateLimit: (config: Record<string, unknown>) => {
    rateLimitConfigs.push(config);
    return async (_context: unknown, next: () => Promise<void>) => next();
  },
  moneyRateLimit: (config: Record<string, unknown>) => {
    rateLimitConfigs.push({
      ...config,
      failClosed: true,
      localLease: false,
    });
    return async (_context: unknown, next: () => Promise<void>) => next();
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockClear();
  getSettings.mockClear();
  getSettings.mockResolvedValue({
    enabled: false,
    amount: null,
    threshold: null,
    hasPaymentMethod: true,
  });
  updateSettings.mockClear();
  updateSettings.mockResolvedValue(undefined);
  findOrganizationById.mockClear();
  findOrganizationById.mockResolvedValue({
    id: ORGANIZATION_ID,
    pay_as_you_go_from_earnings: false,
  });
  updateOrganization.mockClear();
});

describe("billing settings cutover safety", () => {
  test("keeps GET standard and makes PUT the shared MONEY fail-closed policy", () => {
    expect(rateLimitConfigs).toEqual([
      STANDARD_RATE_LIMIT,
      { ...STANDARD_RATE_LIMIT, failClosed: true, localLease: false },
    ]);
  });

  test("returns honest null values for disabled corrupt settings", async () => {
    const response = await app.fetch(new Request("http://internal/"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      settings: {
        autoTopUp: {
          enabled: false,
          amount: null,
          threshold: null,
        },
      },
    });
  });

  test("persists a fail-closed disable and returns null corrupt values", async () => {
    const response = await app.fetch(
      new Request("http://internal/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoTopUp: { enabled: false } }),
      }),
    );

    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(ORGANIZATION_ID, {
      enabled: false,
      amount: undefined,
      threshold: undefined,
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      settings: {
        autoTopUp: {
          enabled: false,
          amount: null,
          threshold: null,
        },
      },
    });
  });

  test("returns a sanitized 400 when corrupt values are enabled implicitly", async () => {
    updateSettings.mockRejectedValueOnce(
      new AutoTopUpSettingsValidationError("private corrupt value: NaN"),
    );

    const response = await app.fetch(
      new Request("http://internal/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoTopUp: { enabled: true } }),
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error:
        "Valid auto top-up values are required to replace corrupt settings.",
      code: "validation_error",
    });
    expect(JSON.stringify(body)).not.toContain("NaN");
  });

  test("returns the same sanitized 400 for a partial update with hidden corruption", async () => {
    updateSettings.mockRejectedValueOnce(
      new AutoTopUpSettingsValidationError(
        "private corrupt threshold: not-a-number",
      ),
    );

    const response = await app.fetch(
      new Request("http://internal/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoTopUp: { amount: 25 } }),
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error:
        "Valid auto top-up values are required to replace corrupt settings.",
      code: "validation_error",
    });
    expect(JSON.stringify(body)).not.toContain("not-a-number");
  });
});
