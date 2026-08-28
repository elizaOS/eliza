/**
 * Container-billing cron driver coverage.
 *
 * The daily container-billing cron (`route.ts`) is the real-money debit driver
 * for hosted containers, and it had no test. It owns the orchestration that the
 * pure policy/repository units can't cover on their own:
 *  - computing each container's dailyCost,
 *  - the earnings-first-then-credits split,
 *  - draining the in-memory earnings/credit pools ACROSS containers in the same
 *    org within a single run,
 *  - the documented fallback that charges the full day to credits when the
 *    earnings conversion throws (a prior bug-fix — guarded here against
 *    regression),
 *  - isolating a per-container failure so the rest of the run still bills,
 *  - skipping an already-billed period without charging.
 *
 * Mirrors the sibling `agent-billing/route.test.ts`: mock ONLY the repo/data
 * seam (`listBillableContainers`, `listBillingOrganizations`,
 * `recordSuccessfulDailyBilling`, earnings/users) and drive the REAL Hono route
 * handler so the real split + pool-drain + fallback orchestration executes.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  ContainerBillingRepository,
  RecordSuccessfulBillingInput,
} from "@/db/repositories/container-billing";

// ── Repo/data seam mocks (the ONLY things stubbed) ─────────────────────────────

const listBillableContainers = mock(
  async (_now: Date): Promise<unknown[]> => [],
);
const listBillingOrganizations = mock(
  async (_ids: string[]): Promise<unknown[]> => [],
);
const scheduleShutdownWarning = mock(async () => true);
const recordBillingFailure = mock(async () => undefined);
const suspendContainer = mock(async () => undefined);
type RecordSuccessfulBillingResult = Awaited<
  ReturnType<ContainerBillingRepository["recordSuccessfulDailyBilling"]>
>;

/**
 * Faithful stand-in for the real `recordSuccessfulDailyBilling`: it returns the
 * route-computed `newBalance` (= currentBalance - fromCredits) and a transaction
 * id, exactly like the real repo's relative-decrement write. Per-call behavior
 * (already-billed / throwing) is overridden in individual tests.
 */
const recordSuccessfulDailyBilling = mock(
  async (
    input: RecordSuccessfulBillingInput,
  ): Promise<RecordSuccessfulBillingResult> => ({
    newBalance: input.newBalance,
    transactionId: "tx-mock",
    alreadyBilled: false,
    amount: input.dailyCost,
    fromEarnings: input.fromEarnings,
  }),
);

const convertToCredits = mock(async (_params: unknown) => ({
  success: true,
  newBalance: 0,
  ledgerEntryId: "ledger-mock",
}));
const getBalance = mock(async (_userId: string) => ({ availableBalance: 0 }));
const listRecoverableContainerStopIntents = mock(
  async (_now: Date) => [] as unknown[],
);
const rearmRecoverableContainerStopIntentOnce = mock(
  async (_input: unknown) => ({
    id: "recovered-stop-job",
    rearmed: true,
  }),
);
const enqueueContainerStopOnce = mock(async () => ({
  requested: true,
  id: "stop-job",
  created: true,
}));
const triggerImmediate = mock(async (_env: unknown) => undefined);
const sendContainerShutdownWarningEmail = mock(
  async (_input: unknown) => undefined,
);

const listByOrganization = mock(
  async (
    _orgId: string,
  ): Promise<
    { id: string; role: string; email: string | null; created_at: Date }[]
  > => [
    {
      id: "owner-user",
      role: "owner",
      email: "owner@example.test",
      created_at: new Date("2020-01-01T00:00:00Z"),
    },
  ],
);

mock.module("@/db/repositories/container-billing", () => ({
  containerBillingRepository: {
    listBillableContainers,
    listBillingOrganizations,
    scheduleShutdownWarning,
    recordBillingFailure,
    suspendContainer,
    recordSuccessfulDailyBilling,
  },
}));

mock.module("@/db/repositories", () => ({
  // Preserve exports consumed by later files in Bun's shared test batch.
  appsRepository: {},
  apiKeysRepository: {},
  usersRepository: {
    listByOrganization,
  },
}));

mock.module("@/lib/services/redeemable-earnings", () => ({
  redeemableEarningsService: {
    convertToCredits,
    getBalance,
  },
}));

mock.module("@/lib/services/email", () => ({
  emailService: {
    sendContainerShutdownWarningEmail,
  },
}));

mock.module("@/lib/services/container-stop-job-service", () => ({
  enqueueContainerStop: mock(async () => undefined),
  enqueueContainerStopOnce,
  listRecoverableContainerStopIntents,
  rearmRecoverableContainerStopIntentOnce,
}));

mock.module("@/lib/services/container-jobs-writer", () => ({
  containerJobsWriter: {},
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    triggerImmediate,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (
    c: { json: (b: unknown, s?: number) => Response },
    error: unknown,
  ) => c.json({ success: false, error: String(error) }, 500),
  ApiError: class ApiError extends Error {},
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireCronSecret: () => undefined,
}));

mock.module("@/lib/constants/pricing", () => ({
  CONTAINER_PRICING: {
    DAILY_RUNNING_COST: 0.67,
    SHUTDOWN_WARNING_HOURS: 48,
    LOW_CREDITS_WARNING_THRESHOLD: 2,
  },
  calculateDailyContainerCost: () => 0.67,
  CONTAINER_LIMITS: {},
}));

mock.module("@/lib/services/container-billing-policy", () => ({
  computeContainerBillingPlan: (input: {
    dailyCost: number;
    currentBalance: number;
    ownerEarningsAvailable: number;
    payAsYouGoFromEarnings: boolean;
  }) => {
    const earningsEligible = input.payAsYouGoFromEarnings
      ? input.ownerEarningsAvailable
      : 0;
    const totalAvailable = input.currentBalance + earningsEligible;
    if (totalAvailable < input.dailyCost) {
      return {
        action: "insufficient" as const,
        fromEarnings: 0,
        fromCredits: 0,
        totalAvailable,
        earningsEligible,
      };
    }
    const fromEarnings = Math.min(earningsEligible, input.dailyCost);
    return {
      action: "billed" as const,
      fromEarnings,
      fromCredits: input.dailyCost - fromEarnings,
      totalAvailable,
      earningsEligible,
    };
  },
}));

const { default: app } = await import("./route");

const ORG_ID = "11111111-1111-1111-1111-111111111111";

function makeContainer(overrides: Record<string, unknown> = {}) {
  return {
    id: "c-1",
    name: "web",
    project_name: "proj",
    organization_id: ORG_ID,
    user_id: "owner-user",
    status: "running",
    billing_status: "active",
    desired_count: 1,
    cpu: 1,
    memory: 1024,
    shutdown_warning_sent_at: null,
    scheduled_shutdown_at: null,
    total_billed: "0",
    ...overrides,
  };
}

function makeOrg(overrides: Record<string, unknown> = {}) {
  return {
    id: ORG_ID,
    name: "Acme",
    credit_balance: "100",
    billing_email: "billing@example.test",
    pay_as_you_go_from_earnings: true,
    ...overrides,
  };
}

async function runCron(): Promise<Response> {
  return await app.fetch(
    new Request("https://api.example.test/", {
      headers: { authorization: "Bearer cron-secret" },
    }),
    {
      CRON_SECRET: "cron-secret",
      NEXT_PUBLIC_APP_URL: "https://www.elizacloud.ai",
    },
  );
}

describe("container-billing cron", () => {
  beforeEach(() => {
    listBillableContainers.mockReset();
    listBillingOrganizations.mockReset();
    scheduleShutdownWarning.mockReset();
    recordBillingFailure.mockReset();
    suspendContainer.mockReset();
    recordSuccessfulDailyBilling.mockReset();
    convertToCredits.mockReset();
    getBalance.mockReset();
    listByOrganization.mockReset();
    listRecoverableContainerStopIntents.mockReset();
    rearmRecoverableContainerStopIntentOnce.mockReset();
    enqueueContainerStopOnce.mockReset();
    triggerImmediate.mockReset();
    sendContainerShutdownWarningEmail.mockReset();

    // Default happy-path behaviors.
    recordSuccessfulDailyBilling.mockImplementation(async (input) => ({
      newBalance: input.newBalance,
      transactionId: "tx-mock",
      alreadyBilled: false,
      amount: input.dailyCost,
      fromEarnings: input.fromEarnings,
    }));
    convertToCredits.mockImplementation(async () => ({
      success: true,
      newBalance: 0,
      ledgerEntryId: "ledger-mock",
    }));
    getBalance.mockImplementation(async () => ({ availableBalance: 0 }));
    listRecoverableContainerStopIntents.mockImplementation(async () => []);
    rearmRecoverableContainerStopIntentOnce.mockImplementation(async () => ({
      id: "recovered-stop-job",
      rearmed: true,
    }));
    enqueueContainerStopOnce.mockImplementation(async () => ({
      requested: true,
      id: "stop-job",
      created: true,
    }));
    triggerImmediate.mockImplementation(async () => undefined);
    scheduleShutdownWarning.mockImplementation(async () => true);
    sendContainerShutdownWarningEmail.mockImplementation(async () => undefined);
    listByOrganization.mockImplementation(async () => [
      {
        id: "owner-user",
        role: "owner",
        email: "owner@example.test",
        created_at: new Date("2020-01-01T00:00:00Z"),
      },
    ]);
  });

  test("recovers a provider-confirmed user stop even when no container is billable", async () => {
    const providerCutoff = new Date("2026-08-26T10:00:00.000Z");
    listRecoverableContainerStopIntents.mockImplementation(async () => [
      {
        id: "intent-user-proof",
        organization_id: ORG_ID,
        container_id: "container-user-proof",
        lifecycle_revision: 42,
        authorization: "user_request",
        status: "terminal_attention",
        provider_confirmed_at: providerCutoff,
        // Explicit user cancellations do not have a scheduled shutdown; the
        // recovery seam is intent-scoped and must not depend on that field.
      },
    ]);
    listBillableContainers.mockImplementation(async () => []);

    const response = await runCron();
    expect(response.status).toBe(200);
    expect(rearmRecoverableContainerStopIntentOnce).toHaveBeenCalledTimes(1);
    expect(rearmRecoverableContainerStopIntentOnce).toHaveBeenCalledWith({
      intentId: "intent-user-proof",
      containerId: "container-user-proof",
      organizationId: ORG_ID,
      lifecycleRevision: 42,
      now: expect.any(Date),
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
    expect(listBillingOrganizations).not.toHaveBeenCalled();
  });

  test("returns a structured degraded response when the recovery scan fails", async () => {
    listRecoverableContainerStopIntents.mockRejectedValueOnce(
      new Error("scan secret must not escape"),
    );
    listBillableContainers.mockResolvedValueOnce([]);

    const response = await runCron();
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(bodyText).not.toContain("scan secret must not escape");
    expect(JSON.parse(bodyText)).toMatchObject({
      success: false,
      code: "container_stop_recovery_degraded",
      data: {
        stopRecovery: {
          status: "degraded",
          scanned: 0,
          rearmed: 0,
          failures: 1,
        },
      },
    });
  });

  test("returns a structured degraded response when one recovery rearm fails", async () => {
    listRecoverableContainerStopIntents.mockResolvedValueOnce([
      {
        id: "intent-poison",
        organization_id: ORG_ID,
        container_id: "container-poison",
        lifecycle_revision: 43,
      } as never,
    ]);
    rearmRecoverableContainerStopIntentOnce.mockRejectedValueOnce(
      new Error("poison detail must not escape"),
    );
    listBillableContainers.mockResolvedValueOnce([]);

    const response = await runCron();
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(bodyText).not.toContain("poison detail must not escape");
    expect(JSON.parse(bodyText)).toMatchObject({
      success: false,
      code: "container_stop_recovery_degraded",
      data: {
        stopRecovery: {
          status: "degraded",
          scanned: 1,
          rearmed: 0,
          failures: 1,
        },
      },
    });
  });

  test("bills a single container at the $0.67 daily cost, charged purely to credits when no earnings", async () => {
    listBillableContainers.mockImplementation(async () => [makeContainer()]);
    listBillingOrganizations.mockImplementation(async () => [
      makeOrg({ credit_balance: "100" }),
    ]);
    getBalance.mockImplementation(async () => ({ availableBalance: 0 }));

    const response = await runCron();
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: {
        containersProcessed: number;
        containersBilled: number;
        totalRevenue: number;
        errors: number;
        results: {
          action: string;
          amount?: number;
          paidFromEarnings?: number;
        }[];
      };
    };

    expect(json.data.containersProcessed).toBe(1);
    expect(json.data.containersBilled).toBe(1);
    expect(json.data.totalRevenue).toBeCloseTo(0.67, 2);
    expect(json.data.errors).toBe(0);
    expect(json.data.results[0].action).toBe("billed");
    expect(json.data.results[0].amount).toBeCloseTo(0.67, 4);
    expect(json.data.results[0].paidFromEarnings).toBeCloseTo(0, 4);

    // No earnings → nothing converted; the full day was charged to credits.
    expect(convertToCredits).not.toHaveBeenCalled();
    expect(recordSuccessfulDailyBilling).toHaveBeenCalledTimes(1);
    const billArg = recordSuccessfulDailyBilling.mock.calls[0][0] as {
      fromEarnings: number;
      fromCredits: number;
      dailyCost: number;
    };
    expect(billArg.dailyCost).toBeCloseTo(0.67, 4);
    expect(billArg.fromEarnings).toBeCloseTo(0, 4);
    expect(billArg.fromCredits).toBeCloseTo(0.67, 4);
  });

  test("drains earnings first, then the in-memory pool ACROSS two same-org containers in one run", async () => {
    // One org, $1.00 of owner earnings, plenty of credits. Two $0.67 containers.
    // Container A: earnings cover the full $0.67 (fromEarnings=0.67, fromCredits=0).
    // Pool drains to $0.33 earnings → Container B: earnings cover $0.33, credits cover $0.34.
    listBillableContainers.mockImplementation(async () => [
      makeContainer({ id: "c-A", name: "A" }),
      makeContainer({ id: "c-B", name: "B" }),
    ]);
    listBillingOrganizations.mockImplementation(async () => [
      makeOrg({ credit_balance: "100" }),
    ]);
    getBalance.mockImplementation(async () => ({ availableBalance: 1.0 }));

    const response = await runCron();
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: { containersBilled: number; results: { action: string }[] };
    };
    expect(json.data.containersBilled).toBe(2);
    expect(json.data.results.every((r) => r.action === "billed")).toBe(true);

    expect(recordSuccessfulDailyBilling).toHaveBeenCalledTimes(2);
    const a = recordSuccessfulDailyBilling.mock.calls[0][0] as {
      fromEarnings: number;
      fromCredits: number;
    };
    const b = recordSuccessfulDailyBilling.mock.calls[1][0] as {
      fromEarnings: number;
      fromCredits: number;
    };

    // Container A: earnings absorb the whole bill.
    expect(a.fromEarnings).toBeCloseTo(0.67, 4);
    expect(a.fromCredits).toBeCloseTo(0, 4);

    // Container B sees the DRAINED pool ($1.00 - $0.67 = $0.33 left).
    expect(b.fromEarnings).toBeCloseTo(0.33, 4);
    expect(b.fromCredits).toBeCloseTo(0.34, 4);

    // Conversion is owned by the repository transaction, never the route.
    expect(convertToCredits).not.toHaveBeenCalled();
  });

  test("route never performs a crash-separable earnings conversion", async () => {
    listBillableContainers.mockImplementation(async () => [makeContainer()]);
    listBillingOrganizations.mockImplementation(async () => [
      makeOrg({ credit_balance: "100" }),
    ]);
    // Owner has earnings; the repository will lock and convert atomically.
    getBalance.mockImplementation(async () => ({ availableBalance: 1.0 }));
    // A legacy route-level conversion seam throwing must be irrelevant.
    convertToCredits.mockImplementation(async () => {
      throw new Error("earnings ledger contended");
    });

    const response = await runCron();
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: {
        containersBilled: number;
        errors: number;
        results: { action: string }[];
      };
    };

    // The container is STILL billed (not left unbilled / free hosting), and it
    // is NOT an error — the fallback caught the throw.
    expect(json.data.containersBilled).toBe(1);
    expect(json.data.errors).toBe(0);
    expect(json.data.results[0].action).toBe("billed");

    expect(convertToCredits).not.toHaveBeenCalled();
    const billArg = recordSuccessfulDailyBilling.mock.calls[0][0] as {
      fromEarnings: number;
      fromCredits: number;
      dailyCost: number;
    };
    expect(billArg.fromEarnings).toBeCloseTo(0.67, 4);
    expect(billArg.fromCredits).toBeCloseTo(0, 4);
    expect(billArg.dailyCost).toBeCloseTo(0.67, 4);
  });

  test("isolates a per-container failure: errors:1 / action:error while the other container still bills", async () => {
    listBillableContainers.mockImplementation(async () => [
      makeContainer({ id: "c-good", name: "good" }),
      makeContainer({ id: "c-bad", name: "bad" }),
    ]);
    listBillingOrganizations.mockImplementation(async () => [
      makeOrg({ credit_balance: "100" }),
    ]);
    getBalance.mockImplementation(async () => ({ availableBalance: 0 }));

    // The billing write throws for the SECOND container only.
    recordSuccessfulDailyBilling.mockImplementation(
      async (input: { containerId: string; newBalance: number }) => {
        if (input.containerId === "c-bad") {
          throw new Error("db write failed for bad container");
        }
        return {
          newBalance: input.newBalance,
          transactionId: "tx-mock",
          alreadyBilled: false,
        };
      },
    );

    const response = await runCron();
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: {
        containersBilled: number;
        errors: number;
        results: { action: string; error?: string }[];
      };
    };

    // One billed, one errored — the failure did NOT abort the whole run.
    expect(json.data.containersBilled).toBe(1);
    expect(json.data.errors).toBe(1);

    const good = json.data.results.find((r) => r.action === "billed");
    const bad = json.data.results.find((r) => r.action === "error");
    expect(good).toBeDefined();
    expect(bad).toBeDefined();
    expect(bad?.error).toContain("db write failed");
  });

  test("alreadyBilled period → action:skipped, NOT billed (no revenue, no double-charge)", async () => {
    listBillableContainers.mockImplementation(async () => [makeContainer()]);
    listBillingOrganizations.mockImplementation(async () => [
      makeOrg({ credit_balance: "100" }),
    ]);
    getBalance.mockImplementation(async () => ({ availableBalance: 0 }));

    // The row-lock guard found this period already paid.
    recordSuccessfulDailyBilling.mockImplementation(
      async (input: { newBalance: number }) => ({
        newBalance: input.newBalance,
        transactionId: null,
        alreadyBilled: true,
      }),
    );

    const response = await runCron();
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: {
        containersBilled: number;
        totalRevenue: number;
        errors: number;
        results: { action: string; error?: string }[];
      };
    };

    expect(json.data.containersBilled).toBe(0);
    expect(json.data.totalRevenue).toBeCloseTo(0, 2);
    expect(json.data.errors).toBe(0);
    expect(json.data.results[0].action).toBe("skipped");
    expect(json.data.results[0].error).toContain("Already billed");
  });

  test("a lost shutdown-warning CAS publishes no email or failure receipt", async () => {
    listBillableContainers.mockImplementation(async () => [makeContainer()]);
    listBillingOrganizations.mockImplementation(async () => [
      makeOrg({ credit_balance: "0" }),
    ]);
    scheduleShutdownWarning.mockImplementation(async () => false);

    const response = await runCron();
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: { results: { action: string; error?: string }[] };
    };

    expect(scheduleShutdownWarning).toHaveBeenCalledTimes(1);
    expect(sendContainerShutdownWarningEmail).not.toHaveBeenCalled();
    expect(recordBillingFailure).not.toHaveBeenCalled();
    expect(json.data.results[0]).toMatchObject({
      action: "skipped",
      error: "Container state changed before shutdown warning",
    });
  });

  test("filters invalid member timestamps so corrupt created_at cannot hijack earnings source", async () => {
    listBillableContainers.mockImplementation(async () => [makeContainer()]);
    listBillingOrganizations.mockImplementation(async () => [
      makeOrg({ credit_balance: "100" }),
    ]);
    const invalidMember = {
      id: "invalid-member",
      role: "member",
      email: "invalid@example.test",
      created_at: new Date(Number.NaN),
    };
    const validMember = {
      id: "valid-member",
      role: "member",
      email: "valid@example.test",
      created_at: new Date("2020-01-02T00:00:00Z"),
    };
    listByOrganization.mockImplementation(async () => [
      invalidMember,
      validMember,
    ]);
    let balanceQueriedFor: string | null = null;
    getBalance.mockImplementation(async (userId: string) => {
      balanceQueriedFor = userId;
      return { availableBalance: 5 };
    });

    const response = await runCron();
    expect(response.status).toBe(200);
    expect(balanceQueriedFor!).toBe("valid-member");

    const billed = recordSuccessfulDailyBilling.mock.calls[0]?.[0] as {
      fromEarnings: number;
    };
    expect(billed.fromEarnings).toBeGreaterThan(0);
  });

  test("fails closed when fallback members all have invalid timestamps (no earnings debit)", async () => {
    listBillableContainers.mockImplementation(async () => [makeContainer()]);
    listBillingOrganizations.mockImplementation(async () => [
      makeOrg({ credit_balance: "100" }),
    ]);
    const invalidA = {
      id: "invalid-a",
      role: "member",
      email: "a@example.test",
      created_at: new Date(Number.NaN),
    };
    const invalidB = {
      id: "invalid-b",
      role: "member",
      email: "b@example.test",
      created_at: new Date(Number.NaN),
    };
    listByOrganization.mockImplementation(async () => [invalidA, invalidB]);
    getBalance.mockImplementation(async () => ({ availableBalance: 999 }));

    const response = await runCron();
    expect(response.status).toBe(200);
    expect(getBalance).not.toHaveBeenCalled();
    const billed = recordSuccessfulDailyBilling.mock.calls[0]?.[0] as {
      fromEarnings: number;
      fromCredits: number;
    };
    expect(billed.fromEarnings).toBe(0);
    expect(billed.fromCredits).toBeCloseTo(0.67, 4);
  });
});
