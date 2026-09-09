/** Proves terminal finalization updates primary policy and combined auth admission through real cache hydration and HTTP middleware. Migrated PGlite owns billing state; only external credential verification and rate-limit transport are mocked. */
import { afterAll, beforeAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createBillingSnapshotFixture } from "./account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";
process.env.INFERENCE_AUTH_CACHE_ENABLED = "true";
process.env.INFERENCE_STRONG_REVOCATION_ENABLED = "true";
let credentialReads = 0;
const consumed: number[] = [];
mock.module("../../lib/services/inference-api-key-auth", () => ({
  requireInferenceApiKeyWithOrg: async () => {
    credentialReads++;
    return { user: { id: "probe-user", organization_id: ORG }, apiKey: { id: "probe-key" } };
  },
}));
mock.module("../../lib/services/inference-credential-revocation", () => ({
  isInferenceStrongRevocationEnabled: () => true,
  InferenceCredentialRevokedError: class extends Error {},
  assertInferenceCredentialActive: async () => undefined,
  inferenceCredentialRevocationReason: () => "credential_invalid",
  revokeInferenceApiKey: async () => undefined,
  setInferenceSessionBindingActive: async () => undefined,
  revokeInferenceSessionsThrough: async () => undefined,
  setInferenceOrganizationActive: async () => undefined,
  setInferenceSubjectActive: async () => undefined,
}));
mock.module("../../lib/services/admin", () => ({
  adminService: { shouldBlockUserConsistent: async () => false },
}));
mock.module("../../lib/services/content-moderation", () => ({
  contentModerationService: { shouldBlockUser: async () => false },
}));
mock.module("../../lib/services/api-keys", () => ({
  apiKeysService: { incrementUsageDebounced: async () => undefined },
  isMobileApiKeySecret: () => false,
}));
mock.module("../../lib/services/inference-app-key-scope", () => ({
  loadInferenceAppKeyScope: async () => null,
}));
mock.module("../../lib/services/inference-admission-gate", () => ({
  consumeInferenceRateLimit: async (input: { maxRequests: number }) => {
    consumed.push(input.maxRequests);
    return { allowed: true, remaining: input.maxRequests - 1, resetAt: Date.now() + 60000 };
  },
  InferenceAdmissionGateUnavailableError: class extends Error {},
}));
setDefaultTimeout(120_000);
const ORG = "61000000-0000-4000-8000-000000000001";
const SUB = "62000000-0000-4000-8000-000000000001";
let database: typeof import("../client");
let policy: typeof import("../../lib/services/organization-quota-policy");
beforeAll(async () => {
  database = await import("../client");
  const pg = database.getPgliteClientForTests();
  await createBillingSnapshotFixture((query) => pg.exec(query), "");
  await pg.exec(`ALTER TABLE billing_subscription_revisions DISABLE TRIGGER billing_subscription_revisions_immutable_guard;
    UPDATE billing_subscriptions SET current_period_start = now()-interval '1 day', current_period_end=now()+interval '1 day';
    UPDATE billing_subscription_revisions SET current_period_start=(SELECT current_period_start FROM billing_subscriptions LIMIT 1), current_period_end=(SELECT current_period_end FROM billing_subscriptions LIMIT 1);
    ALTER TABLE billing_subscription_revisions ENABLE TRIGGER billing_subscription_revisions_immutable_guard;
    DELETE FROM organization_entitlements WHERE organization_id='${ORG}';
    UPDATE organizations SET stripe_customer_id='cus_snapshot' WHERE id='${ORG}';
`);
  const noticeMigration = await readFile(
    new URL("../migrations/0382_subscription_notice_intents.sql", import.meta.url),
    "utf8",
  );
  for (const statement of noticeMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await pg.exec(statement);
  }
  const customerMigration = await readFile(
    new URL("../migrations/0267_stripe_customer_attempts.sql", import.meta.url),
    "utf8",
  );
  for (const statement of customerMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await pg.exec(statement);
  }
  const { subscriptionEntitlementsRepository } = await import("./subscription-entitlements");
  await subscriptionEntitlementsRepository.rebuild({
    organizationId: ORG,
    sourceSubscriptionId: SUB,
    sourceSubscriptionRevision: 1,
    expectedProjectionRevision: null,
  });
  policy = await import("../../lib/services/organization-quota-policy");
});
afterAll(async () => {
  await database.closeDatabaseConnectionsForTests();
});

test("combined auth and HTTP middleware recover after terminal finalization", async () => {
  const { Hono } = await import("hono");
  const { resolveInferenceAuthContext } = await import("../../lib/services/inference-auth-context");
  const { enforceOrgRateLimit, OrgRateLimitCacheNotReadyError } = await import(
    "../../lib/middleware/rate-limit"
  );
  const { inferenceRateLimitConfig } = await import(
    "../../lib/services/inference-admission-snapshot"
  );
  const { readInferenceAuthContext, hashApiKey } = await import(
    "../../lib/services/inference-auth-cache"
  );
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
  const app = new Hono();
  app.get("/", async (c) => {
    const auth = await resolveInferenceAuthContext(c.req.raw, {
      cacheOnly: true,
      executionCtx,
      deferStrongCredentialCheck: true,
    });
    if (auth.kind !== "authorized") return c.json({ kind: auth.kind }, 503);
    if (!auth.ctx.admission) return c.json({ kind: "warming" }, 503);
    try {
      const denial = await enforceOrgRateLimit(auth.ctx.orgId, "completions", {
        cacheOnly: true,
        executionCtx,
        config: inferenceRateLimitConfig(auth.ctx.admission, "completions"),
      });
      if (denial) return denial;
      return c.json({
        source: auth.source,
        generation: auth.ctx.admission.authority.generation,
        rpm: auth.ctx.admission.rateLimits.completionsRpm,
      });
      // error-policy:J1 The HTTP boundary translates expected cache warming into a retryable response.
    } catch (error) {
      if (error instanceof OrgRateLimitCacheNotReadyError) return c.json({ kind: "warming" }, 503);
      throw error;
    }
  });
  const responseSchema = z.object({ source: z.string(), generation: z.string(), rpm: z.number() });
  const readResponse = async (response: Response) => responseSchema.parse(await response.json());
  const request = () => app.request("/", { headers: { "X-API-Key": "eliza_probe_key" } });
  const first = await request();
  expect(first.status).toBe(200);
  const initial = await readResponse(first);
  await Promise.all(pending.splice(0));
  const warm = await request();
  expect(warm.status).toBe(200);
  expect((await readResponse(warm)).source).toBe("cache");
  const { subscriptionAuthorityRepository: authority } = await import("./subscription-authority");
  const { subscriptionBillingOperationsRepository: operations } = await import(
    "./subscription-billing-operations"
  );
  const { readPrimaryAccountBillingSnapshot } = await import("./account-billing-snapshot");
  const source = await authority.findById(ORG, SUB);
  if (!source) throw new Error("Expected current subscription source");
  const eventTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000);
  const receiptId = "64000000-0000-4000-8000-000000000001";
  const leaseToken = "65000000-0000-4000-8000-000000000001";
  await operations.recordEvent({
    id: receiptId,
    organizationId: ORG,
    subscriptionId: SUB,
    providerEventId: "evt_cacheterminal",
    eventType: "customer.subscription.deleted",
    providerObjectType: "subscription",
    providerObjectId: source.stripe_subscription_id,
    livemode: false,
    eventCreatedAt: eventTime,
    payloadDigest: "c".repeat(64),
    now: new Date(),
  });
  await operations.claimEvent({
    organizationId: ORG,
    receiptId,
    leaseToken,
    leaseDurationMs: 60_000,
  });
  await operations.finalizeLifecycleEvent({
    organizationId: ORG,
    subscriptionId: SUB,
    receiptId,
    leaseToken,
    expectedSubscriptionRevision: 1,
    expectedProjectionRevision: 0,
    observation: {
      provider: source.provider,
      provider_environment: source.provider_environment,
      stripe_customer_id: source.stripe_customer_id,
      stripe_subscription_id: source.stripe_subscription_id,
      stripe_subscription_item_id: source.stripe_subscription_item_id,
      catalog_version: source.catalog_version,
      plan_key: source.plan_key,
      status: "canceled",
      current_period_start: source.current_period_start,
      current_period_end: source.current_period_end,
      cancel_at_period_end: false,
      canceled_at: eventTime,
      ended_at: eventTime,
      dunning_started_at: null,
      grace_expires_at: null,
      pending_plan_key: null,
      last_provider_event_id: "evt_cacheterminal",
      last_provider_event_created_at: eventTime,
      provider_object_digest: "d".repeat(64),
    },
  });
  const notices = await database
    .getPgliteClientForTests()
    .query("SELECT source_revision::text,state FROM subscription_notice_intents");
  expect(notices.rows).toEqual([{ source_revision: "2", state: "policy_unavailable" }]);
  const currentPolicy = await policy.readOrganizationQuotaPolicy(ORG);
  if (currentPolicy.tier.status !== "available")
    throw new Error("Expected current terminal policy");
  const primary = await readPrimaryAccountBillingSnapshot(ORG);
  expect(primary.configuredTier).toMatchObject({
    status: "available",
    tier: currentPolicy.tier.value,
  });
  expect(primary.policyLimits).toEqual(currentPolicy.limits);
  expect(primary.subscription).toMatchObject({
    state: "current",
    subscription: { id: SUB, lifecycle_revision: 2, status: "canceled" },
    entitlement: {
      source_subscription_id: SUB,
      source_subscription_revision: 2,
      projection_revision: 1,
      plan_key: "free",
    },
  });
  expect(currentPolicy.authority).toMatchObject({ sourceRevision: "2", projectionRevision: "1" });
  const currentRpm = currentPolicy.tier.value.completionsRpm;
  const next = await request();
  expect(next.status).toBe(200);
  const recovered = await readResponse(next);
  expect(recovered.rpm).toBe(currentRpm);
  expect(BigInt(recovered.generation)).toBe(BigInt(initial.generation) + 1n);
  expect(recovered.generation).toBe(currentPolicy.authority.generation);
  await Promise.all(pending.splice(0));
  const cached = await readInferenceAuthContext(hashApiKey("eliza_probe_key"));
  expect(cached?.admission?.rateLimits.completionsRpm).toBe(currentRpm);
  const final = await request();
  expect(final.status).toBe(200);
  expect((await readResponse(final)).source).toBe("cache");
  expect(consumed).toEqual([initial.rpm, initial.rpm, currentRpm, currentRpm]);
  expect(credentialReads).toBe(2);

  await Promise.all(pending.splice(0));
});
