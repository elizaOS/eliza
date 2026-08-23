/**
 * Exercises the real GET /api/v1/billing/limits Hono boundary with mocked
 * authentication and read-only data adapters. The canonical primary reader
 * receives only the organization resolved from auth; query parameters never
 * become a tenant-selection seam.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const seenOrgIds: string[] = [];
type TestAuthMethod = "session" | "api_key";
let currentAuthMethod: TestAuthMethod = "session";
let currentRole = "member";
let currentUserActive = true;
let currentUserAnonymous = false;
let currentOrganizationActive = true;

async function resolveTestAuth(c: {
  set(key: "authMethod", value: TestAuthMethod): void;
}): Promise<{
  organization_id: string;
  role: string;
  is_active: boolean;
  is_anonymous: boolean;
  organization: { id: string; is_active: boolean };
}> {
  c.set("authMethod", currentAuthMethod);
  return {
    organization_id: "org-authed",
    role: currentRole,
    is_active: currentUserActive,
    is_anonymous: currentUserAnonymous,
    organization: {
      id: "org-authed",
      is_active: currentOrganizationActive,
    },
  };
}

const requireUserOrApiKeyWithOrg = mock(resolveTestAuth);

const readPrimaryAccountBillingSnapshot = mock(
  async (organizationId: string) => {
    seenOrgIds.push(organizationId);
    return {
      observedAt: "2026-08-20T12:00:00.000Z",
      organization: {
        creditBalance: "15.000000",
        balanceRevision: "9007199254740993",
        balanceDecreaseRevision: "2",
        coveredBalanceDecreaseRevision: "1",
        settings: {},
        isActive: true,
        stripeCustomerIdPresent: false,
        stripeCustomerIdValid: false,
        defaultPaymentMethodIdPresent: false,
        defaultPaymentMethodIdValid: false,
        autoTopUpEnabled: false,
        autoTopUpThreshold: null,
        autoTopUpAmount: null,
      },
      cloudCharacterCount: "2",
      sandboxCounts: { used: "1", reserved: "1", deleting: "0" },
      containerCounts: { used: "0", reserved: "0", deleting: "0" },
      containerSettings: {},
      appCount: "1",
      apiKeyCount: "1",
      storageQuota: { bytesUsed: "42", bytesLimit: "1000" },
      configuredTier: {
        status: "available" as const,
        tier: {
          tierName: "paid",
          completionsRpm: 60,
          embeddingsRpm: 120,
          standardRpm: 30,
          strictRpm: 5,
        },
        tierSourceCreditTotal: "15.000000",
        overrides: {
          completionsRpm: null,
          embeddingsRpm: null,
          standardRpm: null,
          strictRpm: null,
        },
      },
      autoTopUp: {
        control: null,
        customerBindingAuthoritative: false,
        blockingAttempt: false,
        blockingLegacyQuarantine: false,
      },
      activeResources: [
        {
          resourceType: "container" as const,
          resourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "route-container",
          status: "running",
          billingStatus: "active",
          lifecycleRevision: 12,
          unitPrice: 1,
          billingInterval: "day" as const,
          lastBilledAt: null,
          nextBillingAt: null,
          estimatedNextBillingAt: null,
          totalBilled: 0,
          cancelEndpoint:
            "/api/v1/billing/resources/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cancel?resourceType=container",
          cancelAction: "stop" as const,
          metadata: {},
        },
      ],
      latestRateSegments: [
        {
          workloadKind: "container" as const,
          workloadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          billingState: "running",
          ratePerHour: "0.100000",
          effectiveAt: new Date("2026-08-20T11:00:00.000Z"),
        },
      ],
    };
  },
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
mock.module("@/db/repositories/account-billing-snapshot", () => ({
  readPrimaryAccountBillingSnapshot,
}));
mock.module("@/db/repositories/org-storage-quota", () => ({
  DEFAULT_ORG_STORAGE_BYTES_LIMIT: 5n * 1024n * 1024n * 1024n,
}));
mock.module("@/lib/services/apps", () => ({
  getMaxAppsPerOrg: () => 25,
}));
mock.module("@/lib/constants/agent-sandbox-quota", () => ({
  getMaxNonTerminalAgentsForOrg: (balance: number | undefined) =>
    balance === undefined ? 5 : 100,
}));
mock.module("@/lib/constants/cloud-character-quota", () => ({
  getMaxCloudCharactersForOrg: () => 100,
}));
mock.module("@/lib/constants/pricing", () => ({
  getMaxContainersForOrg: () => 10,
}));
mock.module("@/lib/services/org-rate-limits", () => ({
  getOrgTierCacheOnly: async (organizationId: string) => {
    seenOrgIds.push(organizationId);
    return { kind: "warming" as const, cacheRead: "miss" as const };
  },
}));

const route = (await import("../v1/billing/limits/route")).default;
const app = new Hono().route("/api/v1/billing/limits", route);

describe("GET /api/v1/billing/limits", () => {
  beforeEach(() => {
    seenOrgIds.length = 0;
    currentAuthMethod = "session";
    currentRole = "member";
    currentUserActive = true;
    currentUserAnonymous = false;
    currentOrganizationActive = true;
    requireUserOrApiKeyWithOrg.mockClear();
    requireUserOrApiKeyWithOrg.mockImplementation(resolveTestAuth);
    readPrimaryAccountBillingSnapshot.mockClear();
  });

  test("a member reads the additive snapshot scoped to the authenticated org", async () => {
    const response = await app.request("/api/v1/billing/limits");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: {
        schemaVersion: number;
        observedAt: string;
        storage: Record<string, unknown>;
        v2: {
          balance: Record<string, unknown>;
          limits: { storage: { reserved: Record<string, unknown> } };
          activeCompute: {
            resources: {
              status: string;
              value: Array<{ cancellationControl: Record<string, unknown> }>;
            };
          };
        };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.schemaVersion).toBe(2);
    expect(body.data.observedAt).toBe("2026-08-20T12:00:00.000Z");
    expect(body.data.storage).toEqual({
      source: "org-storage-quota",
      state: "available",
      bytesUsed: "42",
      bytesLimit: "1000",
    });
    expect(body.data.v2.balance).toMatchObject({
      status: "available",
      source: "organizations",
      value: {
        balance: { value: "15.000000", unit: "usd", currency: "USD" },
        revision: "9007199254740993",
      },
    });
    expect(body.data.v2.limits.storage.reserved).toMatchObject({
      status: "unavailable",
      error: { code: "storage_reservation_decomposition_unavailable" },
    });
    expect(
      body.data.v2.activeCompute.resources.value[0]?.cancellationControl,
    ).toEqual({
      displayAction: "stop",
      method: "POST",
      mode: "stop",
      endpoint:
        "/api/v1/billing/resources/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cancel?resourceType=container",
      expectedLifecycleRevision: 12,
      eligible: false,
      blockers: ["owner_or_admin_role_required"],
    });
    expect(new Set(seenOrgIds)).toEqual(new Set(["org-authed"]));
  });

  test("projects an eligible control only for an owner interactive session", async () => {
    currentRole = "owner";

    const response = await app.request("/api/v1/billing/limits");
    const body = (await response.json()) as {
      data: {
        v2: {
          activeCompute: {
            resources: {
              value: Array<{ cancellationControl: Record<string, unknown> }>;
            };
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(
      body.data.v2.activeCompute.resources.value[0]?.cancellationControl,
    ).toMatchObject({
      eligible: true,
      blockers: [],
    });
  });

  test("projects an API-key owner as ineligible", async () => {
    currentAuthMethod = "api_key";
    currentRole = "owner";

    const response = await app.request("/api/v1/billing/limits");
    const body = (await response.json()) as {
      data: {
        v2: {
          activeCompute: {
            resources: {
              value: Array<{ cancellationControl: Record<string, unknown> }>;
            };
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(
      body.data.v2.activeCompute.resources.value[0]?.cancellationControl,
    ).toMatchObject({
      eligible: false,
      blockers: ["interactive_session_required"],
    });
  });

  test("keeps an anonymous owner session cancellation-ineligible", async () => {
    currentRole = "owner";
    currentUserAnonymous = true;

    const response = await app.request("/api/v1/billing/limits");
    const body = (await response.json()) as {
      data: {
        v2: {
          activeCompute: {
            resources: {
              value: Array<{ cancellationControl: Record<string, unknown> }>;
            };
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(
      body.data.v2.activeCompute.resources.value[0]?.cancellationControl,
    ).toMatchObject({
      eligible: false,
      blockers: ["billing_account_ineligible"],
    });
  });

  test("a client-supplied organization id is ignored", async () => {
    const response = await app.request(
      "/api/v1/billing/limits?organizationId=org-forged",
    );
    expect(response.status).toBe(200);
    expect(seenOrgIds.every((id) => id === "org-authed")).toBe(true);
    expect(seenOrgIds.some((id) => id === "org-forged")).toBe(false);
  });

  test("an auth failure yields the failure envelope without reading an organization", async () => {
    requireUserOrApiKeyWithOrg.mockImplementation(async () => {
      throw new Error("Unauthorized");
    });
    const response = await app.request("/api/v1/billing/limits");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(false);
    expect(readPrimaryAccountBillingSnapshot).not.toHaveBeenCalled();
    expect(seenOrgIds).toHaveLength(0);
  });
});
