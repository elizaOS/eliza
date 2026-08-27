/**
 * Exercises deterministic v2 billing-snapshot assembly across exact values,
 * explicit policy gaps, source outages, and canonical compute-rate segments.
 * The primary read model is mocked; PGlite route coverage proves the database
 * query and transaction boundary separately.
 */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { DrizzleQueryError } from "drizzle-orm";
import type { PrimaryAccountBillingReadModel } from "../../db/repositories/account-billing-snapshot";
import {
  type AccountBillingSnapshotSources,
  buildAccountBillingSnapshot,
} from "./account-limits-snapshot";

const PRIMARY_OBSERVED_AT = "2026-08-20T12:00:00.000Z";
const DEFAULT_STORAGE_LIMIT = 5n * 1024n * 1024n * 1024n;

function healthyPrimary(
  overrides: Partial<PrimaryAccountBillingReadModel> = {},
): PrimaryAccountBillingReadModel {
  return {
    observedAt: PRIMARY_OBSERVED_AT,
    organization: {
      creditBalance: "9.000000",
      balanceRevision: "9007199254740993",
      balanceDecreaseRevision: "9007199254740995",
      coveredBalanceDecreaseRevision: "9007199254740994",
      settings: {},
      isActive: true,
      stripeCustomerIdPresent: true,
      stripeCustomerIdValid: true,
      defaultPaymentMethodIdPresent: true,
      defaultPaymentMethodIdValid: true,
      autoTopUpEnabled: true,
      autoTopUpThreshold: "10.00",
      autoTopUpAmount: "25.00",
    },
    cloudCharacterCount: "4",
    sandboxCounts: { used: "3", reserved: "2", deleting: "2" },
    containerCounts: { used: "2", reserved: "3", deleting: "1" },
    containerSettings: {},
    appCount: "2",
    apiKeyCount: "3",
    storageQuota: {
      bytesUsed: "9007199254740993",
      bytesLimit: "9007199254741000",
    },
    configuredTier: {
      status: "available",
      tier: {
        tierName: "custom",
        completionsRpm: 777,
        embeddingsRpm: 200,
        standardRpm: 60,
        strictRpm: 10,
      },
      tierSourceCreditTotal: "10.123456",
      overrides: {
        completionsRpm: 777,
        embeddingsRpm: null,
        standardRpm: null,
        strictRpm: null,
      },
    },
    autoTopUp: {
      control: {
        mode: "durable",
        pausedAt: new Date("2026-08-20T10:00:00.000Z"),
        legacyReconciledThrough: new Date("2026-08-20T11:00:00.000Z"),
      },
      customerBindingAuthoritative: true,
      blockingAttempt: false,
      blockingLegacyQuarantine: false,
    },
    activeResources: [
      {
        resourceType: "container",
        resourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "exact-rate-container",
        status: "running",
        billingStatus: "active",
        lifecycleRevision: 7,
        unitPrice: 99,
        billingInterval: "day",
        lastBilledAt: "2026-08-20T10:00:00.000Z",
        nextBillingAt: "2026-08-21T10:00:00.000Z",
        estimatedNextBillingAt: "2026-08-21T10:00:00.000Z",
        totalBilled: 0,
        cancelEndpoint:
          "/api/v1/billing/resources/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cancel?resourceType=container",
        cancelAction: "stop",
        metadata: {},
      },
    ],
    latestRateSegments: [
      {
        workloadKind: "container",
        workloadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        billingState: "running",
        ratePerHour: "0.123456",
        effectiveAt: new Date("2026-08-20T11:30:00.000Z"),
      },
    ],
    ...overrides,
  };
}

function healthySources(
  primary: PrimaryAccountBillingReadModel = healthyPrimary(),
  overrides: Partial<AccountBillingSnapshotSources> = {},
): AccountBillingSnapshotSources {
  return {
    primary: async () => primary,
    appLimit: () => 25,
    maxCloudCharacters: () => 5,
    maxNonTerminalAgents: (balance) => (balance === undefined ? 5 : 100),
    maxContainers: () => 5,
    runtimeTierCache: async () => ({
      kind: "ready",
      tier: {
        tierName: "custom",
        completionsRpm: 777,
        embeddingsRpm: 200,
        standardRpm: 60,
        strictRpm: 10,
      },
    }),
    autoTopUpRuntimeEnabled: () => true,
    defaultStorageBytesLimit: DEFAULT_STORAGE_LIMIT,
    now: () => new Date("2026-08-20T12:00:01.000Z"),
    ...overrides,
  };
}

describe("buildAccountBillingSnapshot v2", () => {
  test("is additive, exact, source-provenanced, and projects the unchanged v1 shape", async () => {
    const snapshot = await buildAccountBillingSnapshot(healthySources());

    expect(Object.keys(snapshot).sort()).toEqual([
      "agentSandboxes",
      "apps",
      "cloudCharacters",
      "containers",
      "inferenceRateLimits",
      "observedAt",
      "schemaVersion",
      "storage",
      "v2",
    ]);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.observedAt).toBe(PRIMARY_OBSERVED_AT);
    expect(snapshot.cloudCharacters).toEqual({
      source: "cloud-character-quota",
      state: "available",
      used: 4,
      limit: 5,
    });
    expect(snapshot.agentSandboxes).toMatchObject({
      source: "agent-sandbox-quota",
      used: 5,
      nonEagerCreate: { state: "at-limit", limit: 5 },
      eagerManagedCreate: { state: "available", limit: 100 },
    });
    expect(snapshot.containers).toEqual({
      source: "container-quota",
      state: "at-limit",
      used: 5,
      limit: 5,
    });
    expect(snapshot.storage).toEqual({
      source: "org-storage-quota",
      state: "available",
      bytesUsed: "9007199254740993",
      bytesLimit: "9007199254741000",
    });

    expect(snapshot.v2.snapshotStartedAt).toBe("2026-08-20T12:00:01.000Z");
    expect(snapshot.v2.snapshotCompletedAt).toBe("2026-08-20T12:00:01.000Z");
    expect(snapshot.v2.balance).toEqual({
      status: "available",
      source: "organizations",
      observedAt: PRIMARY_OBSERVED_AT,
      value: {
        balance: { value: "9.000000", unit: "usd", currency: "USD" },
        revision: "9007199254740993",
      },
    });
    expect(snapshot.v2.limits.storage.used).toMatchObject({
      status: "available",
      source: "org-storage-quota",
      observedAt: PRIMARY_OBSERVED_AT,
      value: { value: "9007199254740993", unit: "byte" },
    });
    expect(snapshot.v2.limits.storage.remaining).toMatchObject({
      status: "available",
      value: { value: "7", unit: "byte" },
    });
    expect(snapshot.v2.limits.storage.reserved).toMatchObject({
      status: "unavailable",
      error: {
        code: "storage_reservation_decomposition_unavailable",
        retryable: false,
      },
    });
    expect(snapshot.v2.limits.inference.completions).toMatchObject({
      used: {
        status: "unavailable",
        source: "inference-admission-gate-do",
        error: { code: "inference_window_peek_unavailable", retryable: false },
      },
      reserved: {
        status: "not_applicable",
        source: "inference-admission-gate-do",
      },
      limit: {
        status: "available",
        source: "org-rate-limits",
        value: { value: "777", unit: "request_per_minute" },
      },
    });
    expect(snapshot.v2.limits.apiKeys.limit).toMatchObject({
      status: "unknown_policy",
      source: "api_keys",
      blockedBy: ["#22958"],
    });
    expect(snapshot.v2.tier.eligibilityPolicy).toMatchObject({
      status: "unknown_policy",
      blockedBy: ["#23019"],
    });
    expect(snapshot.v2.tier.configured).toMatchObject({
      status: "available",
      value: {
        selectorKey: "custom",
        tierSourceCreditTotalObserved: {
          value: "10.123456",
          unit: "usd",
          currency: "USD",
        },
      },
    });
    expect(snapshot.v2.limits.inference.weekly).toMatchObject({
      used: { status: "unknown_policy", blockedBy: ["#22962"] },
      reserved: { status: "unknown_policy", blockedBy: ["#22962"] },
      remaining: { status: "unknown_policy", blockedBy: ["#22962"] },
      resetAt: { status: "unknown_policy", blockedBy: ["#22962"] },
    });
    expect(snapshot.v2.paymentMethodPresence).toMatchObject({
      status: "available",
      value: {
        customerIdPresent: true,
        defaultPaymentMethodIdPresent: true,
      },
    });
    expect(snapshot.v2.autoTopUp.readiness).toMatchObject({
      status: "available",
      value: { canStartNewAttempt: true, blockers: [] },
    });
    expect(snapshot.v2.activeCompute.resources).toMatchObject({
      status: "available",
      value: [
        {
          name: "exact-rate-container",
          billingInterval: "day",
          lastBilledAt: "2026-08-20T10:00:00.000Z",
          nextBillingAt: "2026-08-21T10:00:00.000Z",
          estimatedNextBillingAt: "2026-08-21T10:00:00.000Z",
          rateSegment: {
            status: "available",
            source: "compute_billing_rate_segments",
            value: {
              workloadKind: "container",
              billingState: "running",
              effectiveAt: "2026-08-20T11:30:00.000Z",
            },
          },
          ratePerHour: {
            status: "available",
            source: "compute_billing_rate_segments",
            value: { value: "0.123456", unit: "usd_per_hour", currency: "USD" },
          },
          estimatedRecurringComputeCostPerDay: {
            status: "available",
            value: { value: "2.962944", unit: "usd_per_day", currency: "USD" },
          },
        },
      ],
    });
    expect(snapshot.v2.activeCompute.estimatedRecurringComputeCostPerDay).toMatchObject({
      status: "available",
      source: "compute_billing_rate_segments",
      value: { value: "2.962944", unit: "usd_per_day", currency: "USD" },
    });
    expect(snapshot.v2.activeCompute.scope).toMatchObject({
      status: "available",
      value: {
        organizationScoped: true,
        selectors: {
          containers: {
            lifecycleStatuses: ["running"],
            billingStatuses: ["active", "warning", "shutdown_pending"],
          },
          agentSandboxes: {
            excludedExecutionTiers: ["shared"],
            lifecyclePredicates: [
              { status: "running", requiresLastBackup: false },
              { status: "stopped", requiresLastBackup: true },
            ],
          },
        },
        rateAuthority: {
          source: "compute_billing_rate_segments",
          selection: "latest_effective_at_or_before_primary_transaction",
        },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("paidCreditsObserved");
    expect(JSON.stringify(snapshot)).not.toContain('"tierName"');
  });

  test("preserves N-1, N, and N+1 parity for each landed count authority", async () => {
    const cases = [
      { used: "4", expectedState: "available", expectedRemaining: "1" },
      { used: "5", expectedState: "at-limit", expectedRemaining: "0" },
      { used: "6", expectedState: "over-limit", expectedRemaining: "0" },
    ] as const;

    for (const fixture of cases) {
      const snapshot = await buildAccountBillingSnapshot(
        healthySources(
          healthyPrimary({
            cloudCharacterCount: fixture.used,
            sandboxCounts: { used: fixture.used, reserved: "0", deleting: "0" },
            containerCounts: { used: fixture.used, reserved: "0", deleting: "0" },
            appCount: fixture.used,
            storageQuota: { bytesUsed: fixture.used, bytesLimit: "5" },
          }),
          { appLimit: () => 5 },
        ),
      );
      expect(snapshot.cloudCharacters.state).toBe(fixture.expectedState);
      expect(snapshot.agentSandboxes.nonEagerCreate.state).toBe(fixture.expectedState);
      expect(snapshot.containers.state).toBe(fixture.expectedState);
      expect(snapshot.apps.state).toBe(fixture.expectedState);
      expect(snapshot.storage.state).toBe(fixture.expectedState);
      expect(snapshot.v2.limits.cloudCharacters.remaining).toMatchObject({
        status: "available",
        value: { value: fixture.expectedRemaining, unit: "count" },
      });
      expect(snapshot.v2.limits.agentSandboxes.nonEagerCreate.remaining).toMatchObject({
        status: "available",
        value: { value: fixture.expectedRemaining, unit: "count" },
      });
      expect(snapshot.v2.limits.containers.remaining).toMatchObject({
        status: "available",
        value: { value: fixture.expectedRemaining, unit: "count" },
      });
      expect(snapshot.v2.limits.apps.remaining).toMatchObject({
        status: "available",
        value: { value: fixture.expectedRemaining, unit: "count" },
      });
      expect(snapshot.v2.limits.storage.remaining).toMatchObject({
        status: "available",
        value: { value: fixture.expectedRemaining, unit: "byte" },
      });
    }
  });

  test("keeps exact six-decimal balance boundaries aligned with canonical tier helpers", async () => {
    const cases = [
      { balance: "0.999999", characters: 5, sandboxes: 5, containers: 1 },
      { balance: "1.000000", characters: 20, sandboxes: 20, containers: 5 },
      { balance: "1.000001", characters: 20, sandboxes: 20, containers: 5 },
      { balance: "9.999999", characters: 20, sandboxes: 20, containers: 5 },
      { balance: "10.000000", characters: 100, sandboxes: 100, containers: 25 },
      { balance: "10.000001", characters: 100, sandboxes: 100, containers: 25 },
      { balance: "99.999999", characters: 100, sandboxes: 100, containers: 25 },
      { balance: "100.000000", characters: 500, sandboxes: 500, containers: 100 },
      { balance: "100.000001", characters: 500, sandboxes: 500, containers: 100 },
    ];
    const tierIndex = (balance: number): number =>
      balance >= 100 ? 3 : balance >= 10 ? 2 : balance >= 1 ? 1 : 0;

    for (const fixture of cases) {
      const primary = healthyPrimary({
        organization: {
          ...healthyPrimary().organization,
          creditBalance: fixture.balance,
        },
      });
      const snapshot = await buildAccountBillingSnapshot(
        healthySources(primary, {
          // These tables mirror the landed helpers' tested 1/10/100 balance
          // thresholds while keeping this test isolated from Bun route mocks.
          maxCloudCharacters: (balance) => [5, 20, 100, 500][tierIndex(balance)]!,
          maxNonTerminalAgents: (balance) =>
            balance === undefined ? 5 : [5, 20, 100, 500][tierIndex(balance)]!,
          maxContainers: (balance) => [1, 5, 25, 100][tierIndex(balance)]!,
        }),
      );

      expect(snapshot.cloudCharacters.limit).toBe(fixture.characters);
      expect(snapshot.agentSandboxes.eagerManagedCreate.limit).toBe(fixture.sandboxes);
      expect(snapshot.containers.limit).toBe(fixture.containers);
      expect(snapshot.v2.balance).toMatchObject({
        status: "available",
        value: { balance: { value: fixture.balance, unit: "usd", currency: "USD" } },
      });
      if (fixture.balance === "9.999999") {
        expect(snapshot.v2.autoTopUp.readiness).toMatchObject({
          status: "available",
          value: { canStartNewAttempt: true, blockers: [] },
        });
      }
    }
  });

  test("rejects excess monetary precision instead of rounding an authority", async () => {
    const base = healthyPrimary();
    const [balanceSnapshot, autoTopUpSnapshot] = await Promise.all([
      buildAccountBillingSnapshot(
        healthySources(
          healthyPrimary({
            organization: { ...base.organization, creditBalance: "9.0000001" },
          }),
        ),
      ),
      buildAccountBillingSnapshot(
        healthySources(
          healthyPrimary({
            organization: { ...base.organization, autoTopUpAmount: "25.001" },
          }),
        ),
      ),
    ]);

    expect(balanceSnapshot.v2.balance).toMatchObject({
      status: "unavailable",
      source: "organizations",
      error: { code: "invalid_balance_authority", retryable: false },
    });
    expect(balanceSnapshot.v2.limits.cloudCharacters.limit).toMatchObject({
      status: "unavailable",
      error: { code: "character_limit_unavailable", retryable: false },
    });
    expect(autoTopUpSnapshot.v2.autoTopUp.configuration).toMatchObject({
      status: "unavailable",
      source: "organizations",
      error: { code: "auto_top_up_configuration_invalid", retryable: false },
    });
  });

  test("turns an expected primary outage into explicit unavailable observations", async () => {
    const snapshot = await buildAccountBillingSnapshot(
      healthySources(healthyPrimary(), {
        primary: async () => {
          throw new DrizzleQueryError("select primary snapshot", [], new Error("offline"));
        },
      }),
    );

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.cloudCharacters).toMatchObject({
      state: "unavailable",
      reason: "source read failed",
    });
    expect(snapshot.v2.balance).toMatchObject({
      status: "unavailable",
      source: "primary-account-billing-snapshot",
      error: { code: "primary_source_unavailable", retryable: true },
    });
    expect(snapshot.v2.limits.storage.used).toMatchObject({
      status: "unavailable",
      error: { code: "primary_source_unavailable", retryable: true },
    });
    expect(snapshot.v2.tier.eligibilityPolicy).toMatchObject({
      status: "unknown_policy",
      blockedBy: ["#23019"],
    });
    expect(snapshot.v2.tier.runtimeCache).toMatchObject({
      status: "available",
      source: "org-rate-limit-cache",
      value: { selectorKey: "custom", completionsRpm: "777" },
    });
    expect(snapshot.v2.autoTopUp.runtimeSwitch).toMatchObject({
      status: "available",
      source: "AUTO_TOP_UP_DURABLE_ENABLED",
      value: { enabled: true },
    });
    expect(snapshot.v2.limits.inference.completions).toMatchObject({
      used: {
        status: "unavailable",
        source: "inference-admission-gate-do",
        error: { code: "inference_window_peek_unavailable", retryable: false },
      },
      limit: {
        status: "unavailable",
        source: "primary-account-billing-snapshot",
        error: { code: "primary_source_unavailable", retryable: true },
      },
    });
    expect(snapshot.v2.limits.inference.weekly).toMatchObject({
      used: {
        status: "unknown_policy",
        source: "weekly-inference-policy",
        blockedBy: ["#22962"],
      },
      remaining: { status: "unknown_policy", blockedBy: ["#22962"] },
      resetAt: { status: "unknown_policy", blockedBy: ["#22962"] },
    });
  });

  test("settles an immediate cache failure without masking delayed organization-not-found", async () => {
    const primaryError = new ElizaError("organization missing", {
      code: "ACCOUNT_BILLING_ORGANIZATION_NOT_FOUND",
      severity: "fatal",
    });
    let cacheCalls = 0;
    const outcome = buildAccountBillingSnapshot(
      healthySources(healthyPrimary(), {
        primary: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          throw primaryError;
        },
        runtimeTierCache: () => {
          cacheCalls += 1;
          return Promise.reject(new TypeError("immediate cache defect"));
        },
      }),
    );

    await expect(outcome).rejects.toBe(primaryError);
    expect(cacheCalls).toBe(1);
  });

  test("settles an immediate cache failure without masking a delayed unexpected primary error", async () => {
    const primaryError = new TypeError("delayed primary defect");
    let cacheCalls = 0;
    const outcome = buildAccountBillingSnapshot(
      healthySources(healthyPrimary(), {
        primary: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          throw primaryError;
        },
        runtimeTierCache: () => {
          cacheCalls += 1;
          return Promise.reject(new TypeError("immediate cache defect"));
        },
      }),
    );

    await expect(outcome).rejects.toBe(primaryError);
    expect(cacheCalls).toBe(1);
  });

  test("keeps a delayed typed primary outage authoritative over an immediate cache failure", async () => {
    const primaryError = new ElizaError("primary source offline", {
      code: "ACCOUNT_BILLING_PRIMARY_SOURCE_UNAVAILABLE",
      severity: "fatal",
    });
    let cacheCalls = 0;
    const snapshot = await buildAccountBillingSnapshot(
      healthySources(healthyPrimary(), {
        primary: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          throw primaryError;
        },
        runtimeTierCache: () => {
          cacheCalls += 1;
          return Promise.reject(new TypeError("immediate cache defect"));
        },
      }),
    );

    expect(cacheCalls).toBe(1);
    expect(snapshot.v2.balance).toMatchObject({
      status: "unavailable",
      source: "primary-account-billing-snapshot",
      error: { code: "primary_source_unavailable", retryable: true },
    });
    expect(snapshot.v2.tier.runtimeCache).toMatchObject({
      status: "unavailable",
      source: "org-rate-limit-cache",
      error: { code: "runtime_tier_cache_error", retryable: true },
    });
  });

  test("waits for cache settlement before surfacing an early assembly defect", async () => {
    let cacheSettled = false;
    const malformedPrimary = healthyPrimary();
    malformedPrimary.organization =
      null as unknown as PrimaryAccountBillingReadModel["organization"];

    const outcome = buildAccountBillingSnapshot(
      healthySources(malformedPrimary, {
        runtimeTierCache: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          cacheSettled = true;
          return {
            kind: "unavailable",
            cacheRead: "unavailable",
          };
        },
      }),
    );

    await expect(outcome).rejects.toBeInstanceOf(TypeError);
    expect(cacheSettled).toBe(true);
  });

  test("projects a fresh organization's canonical lazy storage default in v1 and v2", async () => {
    const snapshot = await buildAccountBillingSnapshot(
      healthySources(healthyPrimary({ storageQuota: null })),
    );

    expect(snapshot.storage).toEqual({
      source: "org-storage-quota",
      state: "available",
      bytesUsed: "0",
      bytesLimit: DEFAULT_STORAGE_LIMIT.toString(),
    });
    expect(snapshot.v2.limits.storage).toMatchObject({
      used: {
        status: "available",
        source: "org-storage-quota-default",
        value: { value: "0", unit: "byte" },
      },
      limit: {
        status: "available",
        source: "org-storage-quota-default",
        value: { value: DEFAULT_STORAGE_LIMIT.toString(), unit: "byte" },
      },
      remaining: {
        status: "available",
        source: "org-storage-quota-default",
        value: { value: DEFAULT_STORAGE_LIMIT.toString(), unit: "byte" },
      },
      reserved: {
        status: "unavailable",
        error: { code: "storage_reservation_decomposition_unavailable", retryable: false },
      },
    });
  });

  test("fails closed on an invalid lazy storage default in both projections", async () => {
    const snapshot = await buildAccountBillingSnapshot({
      ...healthySources(healthyPrimary({ storageQuota: null })),
      defaultStorageBytesLimit: -1n,
    });

    expect(snapshot.storage).toEqual({
      source: "org-storage-quota",
      state: "unavailable",
      reason: "source read failed",
    });
    expect(snapshot.v2.limits.storage.used).toMatchObject({
      status: "unavailable",
      error: { code: "storage_quota_invalid", retryable: false },
    });
  });

  test("keeps common billing readiness separate from auto-top-up capability blockers", async () => {
    const base = healthyPrimary();
    const snapshot = await buildAccountBillingSnapshot(
      healthySources(
        healthyPrimary({
          organization: {
            ...base.organization,
            creditBalance: "9.000001",
            balanceDecreaseRevision: "3",
            coveredBalanceDecreaseRevision: "3",
            isActive: false,
            stripeCustomerIdPresent: true,
            stripeCustomerIdValid: false,
            defaultPaymentMethodIdPresent: true,
            defaultPaymentMethodIdValid: false,
            autoTopUpThreshold: "1000.01",
            autoTopUpAmount: "0.99",
          },
          autoTopUp: {
            control: {
              mode: "paused",
              pausedAt: new Date("2026-08-20T10:00:00.000Z"),
              legacyReconciledThrough: null,
            },
            customerBindingAuthoritative: false,
            blockingAttempt: true,
            blockingLegacyQuarantine: true,
          },
        }),
        { autoTopUpRuntimeEnabled: () => false },
      ),
    );

    expect(snapshot.v2.billingReadiness).toMatchObject({
      status: "available",
      value: {
        ready: false,
        blockers: [
          "invalid_customer_id",
          "invalid_default_payment_method_id",
          "customer_binding_not_authoritative",
        ],
      },
    });
    expect(snapshot.v2.autoTopUp.readiness).toMatchObject({
      status: "available",
      value: {
        canStartNewAttempt: false,
        blockers: [
          "invalid_customer_id",
          "invalid_default_payment_method_id",
          "customer_binding_not_authoritative",
          "inactive_organization",
          "invalid_threshold",
          "invalid_amount",
          "runtime_switch_disabled",
          "cutover_paused",
          "blocking_attempt",
          "legacy_quarantine",
          "balance_not_rearmed",
        ],
      },
    });
  });

  test.each([
    {
      name: "missing",
      segments: [],
      code: "active_compute_rate_segment_missing",
    },
    {
      name: "future-only",
      segments: [
        {
          workloadKind: "container" as const,
          workloadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          billingState: "running",
          ratePerHour: "0.123456",
          effectiveAt: new Date("2026-08-20T12:00:01.000Z"),
        },
      ],
      code: "active_compute_rate_segment_future_only",
    },
    {
      name: "wrong workload kind",
      segments: [
        {
          workloadKind: "agent" as const,
          workloadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          billingState: "running",
          ratePerHour: "0.123456",
          effectiveAt: new Date("2026-08-20T11:30:00.000Z"),
        },
      ],
      code: "active_compute_rate_segment_kind_mismatch",
    },
    {
      name: "wrong billing state",
      segments: [
        {
          workloadKind: "container" as const,
          workloadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          billingState: "not_billable",
          ratePerHour: "0.123456",
          effectiveAt: new Date("2026-08-20T11:30:00.000Z"),
        },
      ],
      code: "active_compute_rate_segment_state_mismatch",
    },
  ])(
    "preserves active resource identity when its rate segment is $name",
    async ({ segments, code }) => {
      const snapshot = await buildAccountBillingSnapshot(
        healthySources(healthyPrimary({ latestRateSegments: segments })),
      );

      expect(snapshot.v2.activeCompute.resources.status).toBe("available");
      if (snapshot.v2.activeCompute.resources.status !== "available") {
        throw new Error("active resource identities unexpectedly unavailable");
      }
      expect(snapshot.v2.activeCompute.resources.value).toHaveLength(1);
      expect(snapshot.v2.activeCompute.resources.value[0]).toMatchObject({
        resourceType: "container",
        resourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "exact-rate-container",
        rateSegment: { status: "unavailable", error: { code, retryable: false } },
        ratePerHour: { status: "unavailable", error: { code, retryable: false } },
        estimatedRecurringComputeCostPerDay: {
          status: "unavailable",
          error: { code, retryable: false },
        },
      });
      expect(snapshot.v2.activeCompute.estimatedRecurringComputeCostPerDay).toMatchObject({
        status: "unavailable",
        source: "compute_billing_rate_segments",
        error: { code: "active_compute_rate_incomplete", retryable: false },
      });
    },
  );

  test("keeps valid per-resource rates in a mixed snapshot while withholding the aggregate", async () => {
    const base = healthyPrimary();
    const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const snapshot = await buildAccountBillingSnapshot(
      healthySources(
        healthyPrimary({
          activeResources: [
            base.activeResources[0]!,
            {
              ...base.activeResources[0]!,
              resourceType: "agent_sandbox",
              resourceId: agentId,
              name: "missing-rate-agent",
              status: "running",
              billingInterval: "hour",
              cancelAction: "suspend_billing",
              cancelEndpoint: `/api/v1/billing/resources/${agentId}/cancel?resourceType=agent_sandbox`,
            },
          ],
        }),
      ),
    );

    expect(snapshot.v2.activeCompute.resources.status).toBe("available");
    if (snapshot.v2.activeCompute.resources.status !== "available") {
      throw new Error("mixed active resources unexpectedly unavailable");
    }
    expect(snapshot.v2.activeCompute.resources.value[0]?.ratePerHour.status).toBe("available");
    expect(snapshot.v2.activeCompute.resources.value[1]).toMatchObject({
      resourceId: agentId,
      ratePerHour: {
        status: "unavailable",
        error: { code: "active_compute_rate_segment_missing" },
      },
    });
    expect(snapshot.v2.activeCompute.estimatedRecurringComputeCostPerDay).toMatchObject({
      status: "unavailable",
      error: { code: "active_compute_rate_incomplete" },
    });
  });

  test("rethrows active-compute programming defects instead of hiding the resource list", async () => {
    await expect(
      buildAccountBillingSnapshot(
        healthySources(
          healthyPrimary({
            activeResources: [
              null as unknown as PrimaryAccountBillingReadModel["activeResources"][number],
            ],
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("rethrows unexpected cache and runtime-switch adapter failures", async () => {
    await expect(
      buildAccountBillingSnapshot(
        healthySources(healthyPrimary(), {
          runtimeTierCache: async () => {
            throw new TypeError("cache adapter defect");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      buildAccountBillingSnapshot(
        healthySources(healthyPrimary(), {
          autoTopUpRuntimeEnabled: () => {
            throw new TypeError("environment adapter defect");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("does not hide an unexpected implementation defect as source unavailability", async () => {
    await expect(
      buildAccountBillingSnapshot(
        healthySources(healthyPrimary(), {
          primary: async () => {
            throw new TypeError("programming defect");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
