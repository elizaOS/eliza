/**
 * Monetized-app inference selected by X-App-Id. On POST /api/v1/messages an
 * app-scoped key funds inference only for its own app (as
 * /v1/chat/completions does), and monetized-app admission refuses an
 * organization under a billing hold (#22930) the same way the organization
 * lane does, on the Worker and off it. The off-Worker chat completions app
 * lane gets the same hold check.
 *
 * The real route, real app and organization admission, the real clawback hold
 * writer and the real policy lock run on PGlite. The cached auth decision, the
 * rate limiter, catalog pricing, the app lookup, the app debit and the model
 * are stubs; the organization Durable Object is a recording fake. Every case
 * runs under the production and the staging auth flags.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

type Resolution = unknown;
let resolution: Resolution;
let providerCalls = 0;

const realAuthContext = {
  ...(await import(
    "@elizaos/cloud-shared/lib/services/inference-auth-context"
  )),
};
mock.module(
  "@elizaos/cloud-shared/lib/services/inference-auth-context",
  () => ({
    ...realAuthContext,
    resolveInferenceAuthContext: async () => resolution,
  }),
);
const realRateLimit = {
  ...(await import("@elizaos/cloud-shared/lib/middleware/rate-limit")),
};
mock.module("@elizaos/cloud-shared/lib/middleware/rate-limit", () => ({
  ...realRateLimit,
  enforceOrgRateLimit: async () => null,
}));
const realPricing = { ...(await import("@elizaos/cloud-shared/lib/pricing")) };
mock.module("@elizaos/cloud-shared/lib/pricing", () => ({
  ...realPricing,
  calculateCost: async () => ({
    inputCost: 0.05,
    outputCost: 0.05,
    totalCost: 0.1,
  }),
}));
const realLanguageModel = {
  ...(await import("@elizaos/cloud-shared/lib/providers/language-model")),
};
mock.module("@elizaos/cloud-shared/lib/providers/language-model", () => ({
  ...realLanguageModel,
  hasLanguageModelProviderConfigured: () => true,
  resolvePassthroughUpstreamForModel: () => null,
  resolvePooledDirectProviderForModel: () => null,
  getLanguageModel: (modelId: string) => ({
    specificationVersion: "v3",
    provider: "stub",
    modelId,
    supportedUrls: {},
    async doGenerate() {
      providerCalls += 1;
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("Unexpected streaming dispatch");
    },
  }),
}));

import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../../shared/src/db/schemas/billing-subscriptions";
import { creditTransactions } from "../../shared/src/db/schemas/credit-transactions";
import { orgRateLimitOverrides } from "../../shared/src/db/schemas/org-rate-limit-overrides";
import { orgStorageQuota } from "../../shared/src/db/schemas/org-storage-quota";
import { organizationConfig } from "../../shared/src/db/schemas/organization-config";
import { organizationEntitlements } from "../../shared/src/db/schemas/organization-entitlements";
import { organizations } from "../../shared/src/db/schemas/organizations";
import { subscriptionAllowancePeriods } from "../../shared/src/db/schemas/subscription-allowance-periods";
import { users } from "../../shared/src/db/schemas/users";

let dbWrite: typeof import("@elizaos/cloud-shared/db/client").dbWrite;
let closeDb: typeof import("@elizaos/cloud-shared/db/client").closeDatabaseConnectionsForTests;
let route: typeof import("../v1/messages/route").default;
let handleChatCompletionsPOST: typeof import("../v1/chat/completions/route").handleChatCompletionsPOST;

const APP_A = "8a000000-0000-4000-8000-00000000000a";
const APP_B = "8b000000-0000-4000-8000-00000000000b";
const apps = new Map(
  [APP_A, APP_B].map((id) => [
    id,
    {
      id,
      name: `app-${id.slice(0, 2)}`,
      organization_id: crypto.randomUUID(),
      created_by_user_id: crypto.randomUUID(),
      monetization_enabled: true,
      review_status: "approved",
      platform_offset_amount: null,
      purchase_share_percentage: null,
      inference_markup_percentage: "50",
    },
  ]),
);
const appLookups: string[] = [];
const preDispatchDebits: string[] = [];

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import(
    "@elizaos/cloud-shared/db/client"
  ));
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
      join(import.meta.dir, `../../shared/src/db/migrations/${name}`),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await dbWrite.execute(sql.raw(statement));
    }
  }
  for (const [name, table] of [
    ["billing_subscriptions", billingSubscriptions],
    ["billing_subscription_revisions", billingSubscriptionRevisions],
    [
      "organization_subscription_authorities",
      organizationSubscriptionAuthorities,
    ],
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

  const { appsService } = await import(
    "@elizaos/cloud-shared/lib/services/apps"
  );
  spyOn(
    appsService,
    "getAuthorizedMonetizedAppForUserCacheOnly",
  ).mockImplementation((async (id: string) => {
    appLookups.push(id);
    return { kind: "ready", app: apps.get(id) ?? null };
  }) as never);
  spyOn(appsService, "getAuthorizedMonetizedAppForUser").mockImplementation(
    (async (id: string) => {
      appLookups.push(id);
      return apps.get(id) ?? null;
    }) as never,
  );
  const { appCreditsService } = await import(
    "@elizaos/cloud-shared/lib/services/app-credits"
  );
  spyOn(appCreditsService, "reserveInferenceCredits").mockImplementation(
    (async (params: {
      appId: string;
      estimatedBaseCost: number;
      retainChargeOnPostDebitFailure?: boolean;
    }) => {
      // Worker settlement replays this debit after dispatch; only a debit
      // without that marker is a pre-dispatch admission.
      if (!params.retainChargeOnPostDebitFailure)
        preDispatchDebits.push(params.appId);
      const reservedAmount = Math.max(params.estimatedBaseCost, 0.000001) * 1.5;
      return {
        reservedAmount,
        reservationTransactionId: null,
        reconcile: async (actualBaseCost: number) => ({
          reservedAmount,
          actualCost: actualBaseCost * 1.5,
          settlementTransactionIds: [],
          adjustmentType: "none" as const,
        }),
      };
    }) as never,
  );

  route = (await import("../v1/messages/route")).default;
  ({ handleChatCompletionsPOST } = await import(
    "../v1/chat/completions/route"
  ));
}, 300_000);

afterAll(async () => {
  mock.restore();
  await closeDb?.();
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
type Flags = (typeof FLAGS)[keyof typeof FLAGS];

let sequence = 0;
async function seedOrg(
  balance: string,
): Promise<{ orgId: string; userId: string }> {
  sequence += 1;
  const [organization] = await dbWrite
    .insert(organizations)
    .values({
      name: "Org",
      slug: `messages-app-${sequence}-${crypto.randomUUID()}`,
      credit_balance: balance,
    })
    .returning();
  await dbWrite.execute(
    sql`INSERT INTO organization_subscription_authorities (organization_id, state, policy_generation) VALUES (${organization.id}, 'none', 1)`,
  );
  const [user] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: `steward-${crypto.randomUUID()}`,
      organization_id: organization.id,
    })
    .returning();
  return { orgId: organization.id, userId: user.id };
}

/** A $5 unrecovered reversal, then a $20 grant that leaves the balance positive and the hold active. */
async function seedHeldOrg(): Promise<{ orgId: string; userId: string }> {
  const org = await seedOrg("50.000000");
  const { creditsService } = await import(
    "@elizaos/cloud-shared/lib/services/credits"
  );
  await creditsService.clawbackCredits({
    organizationId: org.orgId,
    amount: 55,
    description: "messages hold reversal",
    stripePaymentIntentId: `pi_messages_hold_${crypto.randomUUID()}`,
  });
  await creditsService.addCredits({
    organizationId: org.orgId,
    amount: "20.000000",
    description: "grant while held",
  });
  const { billingHoldService } = await import(
    "@elizaos/cloud-shared/lib/services/billing-hold"
  );
  expect((await billingHoldService.getState(org.orgId)).status).toBe("held");
  return org;
}

async function authorize(
  org: { orgId: string; userId: string },
  appScopeId: string | null,
) {
  const { loadInferenceAdmissionSnapshot } = await import(
    "@elizaos/cloud-shared/lib/services/inference-admission-snapshot"
  );
  resolution = {
    kind: "authorized",
    source: "cache",
    ctx: {
      v: 1,
      cachedAt: Date.now(),
      userId: org.userId,
      orgId: org.orgId,
      apiKeyId: crypto.randomUUID(),
      apiKeyRateLimit: 1000,
      apiKeyExpiresAt: null,
      keyHash: "0".repeat(64),
      appScopeId,
      admission: await loadInferenceAdmissionSnapshot(org.orgId),
    },
  };
}

function recordingGate(paths: string[]) {
  return {
    getByName() {
      return {
        async fetch(request: Request): Promise<Response> {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path === "/lease" || path === "/lease-authorized")
            return Response.json({
              admitted: true,
              availableUsd: 1000,
              requiredUsd: 0.1,
            });
          if (
            path === "/lease-dispatched" ||
            path === "/lease-dispatched-authorized"
          )
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

interface Outcome {
  status: number;
  body: { type: string; error?: { type: string; message: string } };
  gate: string[];
  appLookups: string[];
  preDispatchDebits: string[];
  providerCalls: number;
}

async function send(
  flags: Flags,
  worker: boolean,
  appId: string | null,
): Promise<Outcome> {
  const { runWithCloudBindingsAsync } = await import(
    "@elizaos/cloud-shared/lib/runtime/cloud-bindings"
  );
  const gate: string[] = [];
  const deferred: Promise<unknown>[] = [];
  appLookups.length = 0;
  preDispatchDebits.length = 0;
  providerCalls = 0;
  const bindings = worker
    ? {
        INFERENCE_DEFERRED_ADMISSION: "true",
        INFERENCE_OPTIMISTIC_BILLING: "true",
        INFERENCE_BILLING_LEDGER: "db",
        ...flags,
        INFERENCE_ADMISSION_GATES: recordingGate(gate),
      }
    : { ...flags };
  const response = await runWithCloudBindingsAsync(bindings, async () =>
    route.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(appId ? { "X-App-Id": appId } : {}),
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      worker ? { INFERENCE_DEFERRED_ADMISSION: "true" } : {},
      worker
        ? {
            waitUntil(task: Promise<unknown>) {
              deferred.push(task);
            },
            passThroughOnException() {},
            props: undefined,
          }
        : undefined,
    ),
  );
  const body = (await response.json()) as Outcome["body"];
  const outcome = {
    status: response.status,
    body,
    gate: [...gate],
    appLookups: [...appLookups],
    preDispatchDebits: [...preDispatchDebits],
    providerCalls,
  };
  await Promise.allSettled(deferred);
  return outcome;
}

for (const [flagName, flags] of Object.entries(FLAGS)) {
  for (const worker of [true, false]) {
    const lane = worker ? "Worker" : "off-Worker";
    describe(`${flagName} flags, ${lane}`, () => {
      test("an app-scoped key naming another app in X-App-Id is refused with 403 before any app lookup or admission", async () => {
        await authorize(await seedOrg("50.000000"), APP_A);
        const outcome = await send(flags, worker, APP_B);
        expect(outcome.status).toBe(403);
        expect(outcome.body).toEqual({
          type: "error",
          error: {
            type: "permission_error",
            message: "Access denied to this app",
          },
        });
        expect(outcome.appLookups).toEqual([]);
        expect(outcome.preDispatchDebits).toEqual([]);
        expect(outcome.gate).toEqual([]);
        expect(outcome.providerCalls).toBe(0);
      });

      test("an app-scoped key naming its own app still runs on that app's credits", async () => {
        await authorize(await seedOrg("50.000000"), APP_A);
        const outcome = await send(flags, worker, APP_A);
        expect(outcome.status).toBe(200);
        expect(outcome.body.type).toBe("message");
        expect(outcome.appLookups).toEqual([APP_A]);
        expect(outcome.providerCalls).toBe(1);
        if (worker) {
          expect(outcome.gate).toEqual(["/lease-dispatched"]);
          expect(outcome.preDispatchDebits).toEqual([]);
        } else {
          expect(outcome.gate).toEqual([]);
          expect(outcome.preDispatchDebits).toEqual([APP_A]);
        }
      });

      test("an ordinary key naming a monetized app still runs on that app's credits", async () => {
        await authorize(await seedOrg("50.000000"), null);
        const outcome = await send(flags, worker, APP_B);
        expect(outcome.status).toBe(200);
        expect(outcome.body.type).toBe("message");
        expect(outcome.appLookups).toEqual([APP_B]);
        expect(outcome.providerCalls).toBe(1);
        if (worker) {
          expect(outcome.gate).toEqual(["/lease-dispatched"]);
          expect(outcome.preDispatchDebits).toEqual([]);
        } else {
          expect(outcome.gate).toEqual([]);
          expect(outcome.preDispatchDebits).toEqual([APP_B]);
        }
      });

      test("a held organization with a positive balance is refused on the app lane like the organization lane", async () => {
        const org = await seedHeldOrg();
        await authorize(org, null);
        const organizationLane = await send(flags, worker, null);
        expect(organizationLane.status).toBe(402);
        expect(organizationLane.body.error?.type).toBe("billing_error");
        expect(organizationLane.body.error?.message).toContain(
          "Required: $5.0000",
        );
        expect(organizationLane.gate).toEqual([]);
        expect(organizationLane.providerCalls).toBe(0);

        const appLane = await send(flags, worker, APP_B);
        expect(appLane.status).toBe(organizationLane.status);
        expect(appLane.body.error?.type).toBe(
          organizationLane.body.error?.type,
        );
        expect(appLane.body.error?.message).toContain("Required: $5.0000");
        expect(appLane.appLookups).toEqual([APP_B]);
        expect(appLane.preDispatchDebits).toEqual([]);
        expect(appLane.gate).toEqual([]);
        expect(appLane.providerCalls).toBe(0);
      });
    });
  }
}

interface ChatOutcome {
  status: number;
  body: { error?: { type: string; code: string; message: string } };
  appLookups: string[];
  preDispatchDebits: string[];
  providerCalls: number;
}

async function sendChat(
  flags: Flags,
  appId: string | null,
): Promise<ChatOutcome> {
  const { runWithCloudBindingsAsync } = await import(
    "@elizaos/cloud-shared/lib/runtime/cloud-bindings"
  );
  appLookups.length = 0;
  preDispatchDebits.length = 0;
  providerCalls = 0;
  const response = await runWithCloudBindingsAsync({ ...flags }, () =>
    handleChatCompletionsPOST(
      new Request("https://api.elizacloud.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(appId ? { "X-App-Id": appId } : {}),
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4-6",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      { skipOrgRateLimit: true },
    ),
  );
  return {
    status: response.status,
    body: (await response.json()) as ChatOutcome["body"],
    appLookups: [...appLookups],
    preDispatchDebits: [...preDispatchDebits],
    providerCalls,
  };
}

for (const [flagName, flags] of Object.entries(FLAGS)) {
  describe(`${flagName} flags, off-Worker chat completions`, () => {
    test("a held organization with a positive balance is refused on the app lane like the organization lane", async () => {
      const org = await seedHeldOrg();
      await authorize(org, null);
      const organizationLane = await sendChat(flags, null);
      expect(organizationLane.status).toBe(402);
      expect(organizationLane.body.error).toMatchObject({
        type: "insufficient_quota",
        code: "billing_hold_active",
      });
      expect(organizationLane.providerCalls).toBe(0);

      const appLane = await sendChat(flags, APP_B);
      expect(appLane.status).toBe(organizationLane.status);
      expect(appLane.body.error).toEqual(organizationLane.body.error);
      expect(appLane.appLookups).toEqual([APP_B]);
      expect(appLane.preDispatchDebits).toEqual([]);
      expect(appLane.providerCalls).toBe(0);
    });

    test("a clear organization still debits the monetized app before dispatch", async () => {
      await authorize(await seedOrg("50.000000"), null);
      const outcome = await sendChat(flags, APP_B);
      expect(outcome.status).toBe(200);
      expect(outcome.appLookups).toEqual([APP_B]);
      expect(outcome.preDispatchDebits).toEqual([APP_B]);
      expect(outcome.providerCalls).toBe(1);
    });
  });
}
