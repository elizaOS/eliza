/**
 * Real Hono handler coverage for strict pagination fallback behavior.
 *
 * Authentication, persistence, and telemetry are mocked at their boundaries;
 * production route parsing passes the asserted values to those collaborators.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireAdmin = mock(async () => ({
  role: "admin" as const,
  user: { id: "admin-1" },
}));
const requireUserOrApiKeyWithOrg = mock(async () => ({
  organization_id: "org-1",
}));
const getCurrentUser = mock(async () => null);
mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser,
  requireAdmin,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const getCloudTelemetrySnapshot = mock((limit: number) => ({ limit }));
mock.module("@/lib/observability/cloud-backend-observability", () => ({
  clearCloudTelemetry: mock(() => undefined),
  getCloudTelemetrySnapshot,
}));

const listAuditHistory = mock(
  async (_serviceId: string, _limit: number, _offset: number) => [],
);
mock.module("@/db/repositories", () => ({
  servicePricingRepository: { listAuditHistory },
}));

interface VoiceListOptions {
  includeInactive: boolean;
  cloneType: "instant" | "professional" | undefined;
  limit: number;
  offset: number;
}

const listByOrganization = mock(
  async (_organizationId: string, options: VoiceListOptions) => ({
    voices: [],
    total: 0,
    limit: options.limit,
    offset: options.offset,
    hasMore: false,
  }),
);
mock.module("@/db/repositories/user-voices", () => ({
  userVoicesRepository: { listByOrganization },
}));

const { default: observabilityRoute } = await import(
  "./admin/cloud-observability/route"
);
const { default: auditRoute } = await import(
  "./admin/service-pricing/audit/route"
);
const { default: voiceListRoute } = await import("./voice/list/route");

beforeEach(() => {
  requireAdmin.mockClear();
  requireUserOrApiKeyWithOrg.mockClear();
  getCloudTelemetrySnapshot.mockClear();
  listAuditHistory.mockClear();
  listByOrganization.mockClear();
});

const malformedPositiveIntegers = [
  "5junk",
  "1e4",
  "5.5",
  "-1",
  "0",
  "9007199254740992",
];

describe("cloud observability limit", () => {
  test("uses canonical values, clamps high values, and defaults malformed input", async () => {
    const cases = [
      ["25", 25],
      ["1001", 1_000],
      ...malformedPositiveIntegers.map((value) => [value, 200] as const),
    ] as const;

    for (const [value, expected] of cases) {
      getCloudTelemetrySnapshot.mockClear();
      const response = await observabilityRoute.request(`/?limit=${value}`);
      expect(response.status).toBe(200);
      expect(getCloudTelemetrySnapshot).toHaveBeenCalledWith(expected);
    }
  });
});

describe("service-pricing audit pagination", () => {
  test("strictly parses both limit and offset before repository access", async () => {
    const response = await auditRoute.request(
      "/?service_id=service-1&limit=900&offset=12junk",
    );

    expect(response.status).toBe(200);
    expect(listAuditHistory).toHaveBeenCalledWith("service-1", 500, 0);
  });

  test("defaults malformed limits instead of accepting numeric prefixes", async () => {
    for (const value of malformedPositiveIntegers) {
      listAuditHistory.mockClear();
      const response = await auditRoute.request(
        `/?service_id=service-1&limit=${value}`,
      );
      expect(response.status).toBe(200);
      expect(listAuditHistory).toHaveBeenCalledWith("service-1", 50, 0);
    }
  });
});

describe("voice-list pagination", () => {
  test("strictly parses limit and offset before repository access", async () => {
    const response = await voiceListRoute.request("/?limit=250&offset=8junk");

    expect(response.status).toBe(200);
    expect(listByOrganization.mock.calls[0][1]).toMatchObject({
      limit: 100,
      offset: 0,
    });
  });

  test("defaults malformed limits instead of accepting numeric prefixes", async () => {
    for (const value of malformedPositiveIntegers) {
      listByOrganization.mockClear();
      const response = await voiceListRoute.request(`/?limit=${value}`);
      expect(response.status).toBe(200);
      expect(listByOrganization.mock.calls[0][1]).toMatchObject({
        limit: 50,
        offset: 0,
      });
    }
  });
});
