/**
 * Monetized-app Worker admission honors the organization billing hold
 * (#22930) the same way the organization lane does. Real app and organization
 * admission, the real clawback hold writer and the real policy lock run on
 * PGlite; the organization Durable Object is a recording fake. Every case runs
 * under the production and the staging auth flags.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../../../db/schemas/billing-subscriptions";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import { orgRateLimitOverrides } from "../../../db/schemas/org-rate-limit-overrides";
import { orgStorageQuota } from "../../../db/schemas/org-storage-quota";
import { organizationConfig } from "../../../db/schemas/organization-config";
import { organizationEntitlements } from "../../../db/schemas/organization-entitlements";
import { organizations } from "../../../db/schemas/organizations";
import { subscriptionAllowancePeriods } from "../../../db/schemas/subscription-allowance-periods";
import { users } from "../../../db/schemas/users";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const { apply } = await pushSchema(
    { organizations, users, creditTransactions } as never,
    dbWrite as never,
  );
  await apply();
  for (const name of [
    "0479_organization_payment_reversal_holds.sql",
    "0494_payment_reversal_shortfall_holds.sql",
  ]) {
    const migration = await readFile(
      join(import.meta.dir, `../../../db/migrations/${name}`),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await dbWrite.execute(sql.raw(statement));
    }
  }
  for (const [name, table] of [
    ["billing_subscriptions", billingSubscriptions],
    ["billing_subscription_revisions", billingSubscriptionRevisions],
    ["organization_subscription_authorities", organizationSubscriptionAuthorities],
    ["subscription_allowance_periods", subscriptionAllowancePeriods],
    ["org_rate_limit_overrides", orgRateLimitOverrides],
    ["organization_config", organizationConfig],
    ["organization_entitlements", organizationEntitlements],
    ["org_storage_quota", orgStorageQuota],
  ] as const) {
    await dbWrite.execute(
      sql.raw(
        `CREATE TABLE ${name} (${getTableConfig(table)
          .columns.map((c) => `"${c.name}" ${c.getSQLType()}`)
          .join(",")})`,
      ),
    );
  }
}, 300_000);

afterAll(async () => {
  await closeDb();
});

const FLAGS = {
  production: {
    INFERENCE_AUTH_CACHE_ENABLED: "true",
    INFERENCE_STRONG_REVOCATION_ENABLED: "false",
  },
  staging: {
    INFERENCE_AUTH_CACHE_ENABLED: "true",
    INFERENCE_STRONG_REVOCATION_ENABLED: "true",
  },
} as const;

let sequence = 0;
async function seedOrg(balance: string): Promise<{ orgId: string; userId: string }> {
  sequence += 1;
  const [organization] = await dbWrite
    .insert(organizations)
    .values({
      name: "Org",
      slug: `app-hold-${sequence}-${crypto.randomUUID()}`,
      credit_balance: balance,
    })
    .returning();
  await dbWrite.execute(
    sql`INSERT INTO organization_subscription_authorities (organization_id, state, policy_generation) VALUES (${organization.id}, 'none', 1)`,
  );
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: `steward-${crypto.randomUUID()}`, organization_id: organization.id })
    .returning();
  return { orgId: organization.id, userId: user.id };
}

/** A $5 unrecovered reversal, then a $20 grant that leaves the balance positive and the hold active. */
async function seedHeldOrg(): Promise<{ orgId: string; userId: string }> {
  const org = await seedOrg("50.000000");
  const { creditsService } = await import("../credits");
  const reversal = await creditsService.clawbackCredits({
    organizationId: org.orgId,
    amount: 55,
    description: "app hold reversal",
    stripePaymentIntentId: `pi_app_hold_${crypto.randomUUID()}`,
  });
  expect(reversal.shortfallAmount).toBeCloseTo(5, 6);
  await creditsService.addCredits({
    organizationId: org.orgId,
    amount: "20.000000",
    description: "grant while held",
  });
  const { billingHoldService } = await import("../billing-hold");
  expect((await billingHoldService.getState(org.orgId)).status).toBe("held");
  const balance = await creditsService.getOrganizationBalanceSnapshot(org.orgId);
  expect(balance.balanceUsd).toBeGreaterThan(1);
  return org;
}

function recordingGate(paths: string[]) {
  return {
    getByName() {
      return {
        async fetch(request: Request): Promise<Response> {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path === "/lease" || path === "/lease-authorized")
            return Response.json({ admitted: true, availableUsd: 1000, requiredUsd: 0.1 });
          if (path === "/lease-dispatched" || path === "/lease-dispatched-authorized")
            return Response.json({
              admitted: true,
              availableUsd: 1000,
              requiredUsd: 0.1,
              dispatched: true,
            });
          if (path === "/dispatch") return Response.json({ dispatched: true });
          if (path === "/settle") return Response.json({ settled: true });
          if (path === "/release") return Response.json({ released: true });
          return Response.json({ ok: true });
        },
      };
    },
  };
}

function bindings(flags: (typeof FLAGS)[keyof typeof FLAGS], paths: string[]) {
  return {
    INFERENCE_DEFERRED_ADMISSION: "true",
    INFERENCE_OPTIMISTIC_BILLING: "true",
    INFERENCE_BILLING_LEDGER: "db",
    ...flags,
    INFERENCE_ADMISSION_GATES: recordingGate(paths),
  };
}

async function carriedSnapshot(orgId: string) {
  const { loadInferenceAdmissionSnapshot } = await import("../inference-admission-snapshot");
  return loadInferenceAdmissionSnapshot(orgId);
}

const app = {
  id: crypto.randomUUID(),
  name: "hold-app",
  created_by_user_id: crypto.randomUUID(),
  monetization_enabled: true,
  review_status: "approved",
  platform_offset_amount: null,
  purchase_share_percentage: null,
  inference_markup_percentage: "50",
};

function appAdmissionParams(
  org: { orgId: string; userId: string },
  admissionSnapshot: Awaited<ReturnType<typeof carriedSnapshot>>,
  atomicProviderBoundary: boolean,
) {
  return {
    app: app as never,
    appId: app.id,
    userId: org.userId,
    organizationId: org.orgId,
    estimatedBaseCostUsd: 0.1,
    description: "app hold",
    idempotencyKey: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    model: "openai/gpt-5-mini",
    provider: "openai",
    billingSource: "openai",
    executionCtx: { waitUntil() {} },
    admissionSnapshot,
    atomicProviderBoundary,
  };
}

function organizationAdmissionParams(
  org: { orgId: string; userId: string },
  admissionSnapshot: Awaited<ReturnType<typeof carriedSnapshot>>,
) {
  return {
    context: {
      organizationId: org.orgId,
      userId: org.userId,
      model: "openai/gpt-5-mini",
      provider: "openai",
      billingSource: "openai",
      requestId: crypto.randomUUID(),
    },
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    flatCost: { totalCost: 0.1, baseTotalCost: 0.1, platformMarkup: 0 },
    executionCtx: { waitUntil() {} },
    admissionSnapshot,
  };
}

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (error: unknown) => error,
  );
}

for (const [flagName, flags] of Object.entries(FLAGS)) {
  describe(`${flagName} flags`, () => {
    test("a held organization with a positive balance is refused before any lease, like the organization lane", async () => {
      const { runWithCloudBindingsAsync } = await import("../../runtime/cloud-bindings");
      const { admitAppInferenceCacheOnly } = await import("../app-inference-admission");
      const { admitOrganizationInference } = await import("../organization-inference-admission");
      const org = await seedHeldOrg();
      const carried = await carriedSnapshot(org.orgId);
      // The authoritative hold is read; a stale clear projection does not admit.
      for (const snapshot of [
        { ...carried, billingHold: true },
        { ...carried, billingHold: false },
      ]) {
        for (const atomicProviderBoundary of [false, true]) {
          const appPaths: string[] = [];
          const appError = await runWithCloudBindingsAsync(bindings(flags, appPaths), () =>
            refusal(async () => {
              const admission = await admitAppInferenceCacheOnly(
                appAdmissionParams(org, snapshot, atomicProviderBoundary),
              );
              await admission.markProviderDispatched();
            }),
          );
          const organizationPaths: string[] = [];
          const organizationError = await runWithCloudBindingsAsync(
            bindings(flags, organizationPaths),
            () =>
              refusal(async () => {
                const admission = await admitOrganizationInference(
                  organizationAdmissionParams(org, snapshot),
                );
                await admission.markProviderDispatched?.();
              }),
          );
          expect(organizationError).toMatchObject({
            name: "BillingHoldActiveError",
            code: "billing_hold_active",
            outstandingUsd: "5.000000",
          });
          expect(appError).toMatchObject({
            name: "BillingHoldActiveError",
            code: "billing_hold_active",
            outstandingUsd: "5.000000",
            message: (organizationError as Error).message,
          });
          expect(organizationPaths).toEqual([]);
          expect(appPaths).toEqual([]);
        }
      }
    });

    test("a clear organization still leases and dispatches monetized-app inference", async () => {
      const { runWithCloudBindingsAsync } = await import("../../runtime/cloud-bindings");
      const { admitAppInferenceCacheOnly } = await import("../app-inference-admission");
      const org = await seedOrg("50.000000");
      const snapshot = { ...(await carriedSnapshot(org.orgId)), billingHold: false };
      for (const atomicProviderBoundary of [false, true]) {
        const paths: string[] = [];
        await runWithCloudBindingsAsync(bindings(flags, paths), async () => {
          const admission = await admitAppInferenceCacheOnly(
            appAdmissionParams(org, snapshot, atomicProviderBoundary),
          );
          expect(admission.mode).toBe("deferred_app_reservation");
          expect(admission.estimatedTotalCostUsd).toBeCloseTo(0.15, 6);
          await admission.markProviderDispatched();
        });
        expect(paths).toEqual(
          atomicProviderBoundary ? ["/lease-dispatched"] : ["/lease", "/dispatch"],
        );
      }
    });

    test("a clear organization below the app charge keeps the cached balance refusal", async () => {
      const { runWithCloudBindingsAsync } = await import("../../runtime/cloud-bindings");
      const { admitAppInferenceCacheOnly } = await import("../app-inference-admission");
      const org = await seedOrg("0.100000");
      const snapshot = await carriedSnapshot(org.orgId);
      const paths: string[] = [];
      const error = await runWithCloudBindingsAsync(bindings(flags, paths), () =>
        refusal(() => admitAppInferenceCacheOnly(appAdmissionParams(org, snapshot, true))),
      );
      expect(error).toMatchObject({ name: "InsufficientCreditsError" });
      expect(paths).toEqual([]);
    });
  });
}
