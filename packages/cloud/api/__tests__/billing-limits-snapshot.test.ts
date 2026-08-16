/**
 * Exercises the real GET /api/v1/billing/limits Hono route with mocked auth
 * and data boundaries. Pins the #19777 route contract: the organization comes
 * exclusively from the authenticated membership (a client-supplied org id is
 * ignored), viewers may read the snapshot, and an auth failure never leaks a
 * body. Snapshot assembly itself is covered in cloud-shared.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const seenOrgIds: string[] = [];

const requireUserOrApiKeyWithOrg = mock(
  async (): Promise<{ organization_id: string; role: string }> => ({
    organization_id: "org-authed",
    role: "viewer",
  }),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: "standard" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (
    c: { json: (body: unknown, status: number) => Response },
    error: unknown,
  ) => c.json({ success: false, error: String(error) }, 401),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), warn: mock(), info: mock() },
}));
mock.module("@/db/client", () => ({
  dbRead: {
    query: {
      organizations: {
        findFirst: async () => ({ credit_balance: "15", settings: {} }),
      },
    },
    select: () => ({
      from: () => ({
        where: async () => [{ count: 2 }],
      }),
    }),
  },
}));
mock.module("@/db/repositories/org-storage-quota", () => ({
  DEFAULT_ORG_STORAGE_BYTES_LIMIT: 5n * 1024n * 1024n * 1024n,
  orgStorageQuotaRepository: {
    findByOrganization: async (orgId: string) => {
      seenOrgIds.push(orgId);
      return { bytes_used: 42n, bytes_limit: 1000n };
    },
  },
}));
mock.module("@/lib/services/apps", () => ({
  appsService: {
    countByOrganization: async (orgId: string) => {
      seenOrgIds.push(orgId);
      return 1;
    },
  },
  getMaxAppsPerOrg: () => 25,
}));
mock.module("@/lib/services/container-quota", () => ({
  containerQuotaService: {
    checkQuota: async (orgId: string) => {
      seenOrgIds.push(orgId);
      return { allowed: true, current: 0, max: 10 };
    },
  },
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  QUOTA_COUNTED_STATUSES: [
    "pending",
    "provisioning",
    "running",
    "stopped",
    "sleeping",
  ],
}));
mock.module("@/lib/services/org-rate-limits", () => ({
  readOrgTierFromSources: async (orgId: string) => {
    seenOrgIds.push(orgId);
    return { completionsRpm: 60, embeddingsRpm: 120 };
  },
}));

const route = (await import("../v1/billing/limits/route")).default;
const app = new Hono().route("/api/v1/billing/limits", route);

describe("GET /api/v1/billing/limits", () => {
  beforeEach(() => {
    seenOrgIds.length = 0;
    requireUserOrApiKeyWithOrg.mockClear();
    requireUserOrApiKeyWithOrg.mockImplementation(async () => ({
      organization_id: "org-authed",
      role: "viewer",
    }));
  });

  test("a viewer reads the snapshot scoped to the authenticated org", async () => {
    const response = await app.request("/api/v1/billing/limits");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: Record<string, Record<string, unknown>> & { observedAt: string };
    };
    expect(body.success).toBe(true);
    expect(typeof body.data.observedAt).toBe("string");
    expect(body.data.storage).toEqual({
      source: "org-storage-quota",
      state: "available",
      bytesUsed: "42",
      bytesLimit: "1000",
    });
    // Every boundary was queried with the AUTHENTICATED org.
    expect(new Set(seenOrgIds)).toEqual(new Set(["org-authed"]));
  });

  test("a client-supplied organization id is ignored", async () => {
    const response = await app.request(
      "/api/v1/billing/limits?organizationId=org-else",
    );
    expect(response.status).toBe(200);
    expect(seenOrgIds.every((id) => id === "org-authed")).toBe(true);
    expect(seenOrgIds.some((id) => id === "org-else")).toBe(false);
  });

  test("an auth failure yields the failure envelope, not a snapshot", async () => {
    requireUserOrApiKeyWithOrg.mockImplementation(async () => {
      throw new Error("Unauthorized");
    });
    const response = await app.request("/api/v1/billing/limits");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(false);
    expect(seenOrgIds).toHaveLength(0);
  });
});
