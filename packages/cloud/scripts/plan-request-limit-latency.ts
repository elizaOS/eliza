/**
 * Local latency benchmark for the plan burst and sustained buckets
 * (AlphaCompute/alphaphone#410). It measures what the buckets add to an
 * assistant inference admission under five conditions:
 *
 *   normal          cached plan snapshot, tokens available
 *   cache-miss      no snapshot, first request of a new account (default limits)
 *   exhausted       the account's bucket is empty (429)
 *   expired         the cached plan window has ended (default limits)
 *   billing-outage  the billing database is closed
 *
 * Part 1 times the limiter stage alone: the exact in-memory call that
 * `enforceOrgRateLimit` makes before its policy transaction. Part 2 times
 * `enforceOrgRateLimit` end to end on in-process PGlite with the limiter off
 * and on. PGlite has no network, so part 2 is a lower bound on the existing
 * policy transaction, not a production number. The bucket numbers below are
 * benchmark values only; they are not selected limits.
 *
 * Part 3 times Maps request admission under the same five conditions:
 * `callMapsRequestAllowance` alone (the gate call) and `admitMapsRequest` end
 * to end (primary policy read lock, entitlement read, gate call). The
 * organization is a real subscription-grant subscriber on PGlite. The gate is
 * the real `MapsRequestAllowanceController` on in-memory Durable Object
 * storage, called in process: production adds the Worker-to-Durable-Object
 * hop and the gate's credential revocation read.
 *
 * Run: bun --conditions=eliza-source packages/cloud/scripts/plan-request-limit-latency.ts
 * Output: test-results/plan-request-limit-latency/results.json
 */

import { mock } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "61000000-0000-4000-8000-00000000a410";
const STAGE_ITERATIONS = 20_000;
const E2E_ITERATIONS = 400;
const WARMUP = 50;

/** Benchmark-only numbers, deliberately large so admitted runs never refuse. */
const BENCH_CONFIG = (planKey: string) => ({
  selected: false,
  plans: {
    default: {
      burst: { capacity: 1_000_000, refillPerSecond: 1_000 },
      sustained: { capacity: 1_000_000, refillPerSecond: 1_000 },
    },
    [planKey]: {
      burst: { capacity: 1_000_000, refillPerSecond: 1_000 },
      sustained: { capacity: 1_000_000, refillPerSecond: 1_000 },
    },
    exhausted: {
      burst: { capacity: 1, refillPerSecond: 0.000_001 },
      sustained: { capacity: 1, refillPerSecond: 0.000_001 },
    },
  },
});

/** In-memory stand-in for Durable Object storage: structured copies, serial transactions. */
class MemoryDurableStorage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async put(key: string | Record<string, unknown>, value?: unknown) {
    const entries =
      typeof key === "string" ? [[key, value]] : Object.entries(key);
    for (const [k, v] of entries)
      this.values.set(k as string, structuredClone(v));
  }
  transaction<T>(run: (tx: MemoryDurableStorage) => Promise<T>): Promise<T> {
    return run(this);
  }
}

interface Summary {
  n: number;
  p50: number;
  p95: number;
  mean: number;
}

function summarize(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (v: number) => Math.round(v * 1_000) / 1_000;
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    mean: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
  };
}

async function time(
  iterations: number,
  run: (i: number) => unknown,
): Promise<number[]> {
  for (let i = 0; i < WARMUP; i++) await run(-1 - i);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    await run(i);
    samples.push(performance.now() - started);
  }
  return samples;
}

async function main(): Promise<void> {
  const database = await import("../shared/src/db/client");
  const { createBillingSnapshotFixture } = await import(
    "../shared/src/db/repositories/account-billing-snapshot-test-fixture"
  );
  const exec = async (query: string) => {
    await database.getPgliteClientForTests().exec(query);
  };
  await createBillingSnapshotFixture(exec, "");
  await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${ORG}', '0', 1, 0, '{}', true, false, 'active')`);
  const { enforceOrgRateLimit, OrgRateLimitCacheNotReadyError } = await import(
    "../shared/src/lib/middleware/rate-limit"
  );
  const snapshots = await import(
    "../shared/src/lib/services/inference-admission-snapshot"
  );
  const limiter = await import(
    "../shared/src/lib/services/plan-request-limiter"
  );

  const snapshot = await snapshots.loadInferenceAdmissionSnapshot(ORG);
  const planKey = snapshot.planKey ?? "default";
  const config = snapshots.inferenceRateLimitConfig(snapshot, "completions");
  if (!config)
    throw new Error("admission snapshot produced no rate-limit config");
  const expiredConfig = {
    ...config,
    authority: config.authority && {
      ...config.authority,
      effectiveUntil: new Date(Date.now() - 60_000).toISOString(),
    },
  };
  const exhaustedConfig = { ...config, planKey: "exhausted" };
  const benchJson = JSON.stringify(BENCH_CONFIG(planKey));
  const setLimiter = (on: boolean) => {
    limiter.resetPlanRequestLimiterForTests();
    if (on) process.env.ELIZA_CLOUD_PLAN_RATE_LIMITS = benchJson;
    else delete process.env.ELIZA_CLOUD_PLAN_RATE_LIMITS;
  };
  const exhaust = async (userId: string) => {
    await enforceOrgRateLimit(ORG, "completions", {
      config: exhaustedConfig,
      userId,
    });
  };

  // Part 1: the limiter stage alone.
  setLimiter(true);
  const stage: Record<string, Summary> = {};
  const stageCall = (
    identity: Parameters<typeof limiter.enforcePlanRequestLimit>[0],
  ) => limiter.enforcePlanRequestLimit(identity);
  stage.normal = summarize(
    await time(STAGE_ITERATIONS, () =>
      stageCall({
        organizationId: ORG,
        userId: "normal",
        planKey,
        planEffectiveUntil: config.authority?.effectiveUntil,
      }),
    ),
  );
  stage["cache-miss"] = summarize(
    await time(STAGE_ITERATIONS, (i) =>
      stageCall({ organizationId: ORG, userId: `miss-${i}` }),
    ),
  );
  stageCall({ organizationId: ORG, userId: "spent", planKey: "exhausted" });
  stage.exhausted = summarize(
    await time(STAGE_ITERATIONS, () => {
      const response = stageCall({
        organizationId: ORG,
        userId: "spent",
        planKey: "exhausted",
      });
      if (response?.status !== 429)
        throw new Error("exhausted bucket admitted a request");
    }),
  );
  stage.expired = summarize(
    await time(STAGE_ITERATIONS, () =>
      stageCall({
        organizationId: ORG,
        userId: "expired",
        planKey,
        planEffectiveUntil: expiredConfig.authority?.effectiveUntil,
      }),
    ),
  );

  // Part 2: enforceOrgRateLimit end to end on PGlite, limiter off and on.
  const e2e: Record<
    string,
    { off: Summary; on: Summary; addedP50: number; addedP95: number }
  > = {};
  const compare = async (
    name: string,
    run: (i: number) => Promise<unknown>,
    prepare?: () => Promise<void>,
  ) => {
    setLimiter(false);
    const off = summarize(await time(E2E_ITERATIONS, run));
    setLimiter(true);
    if (prepare) await prepare();
    const on = summarize(await time(E2E_ITERATIONS, run));
    e2e[name] = {
      off,
      on,
      addedP50: Math.round((on.p50 - off.p50) * 1_000) / 1_000,
      addedP95: Math.round((on.p95 - off.p95) * 1_000) / 1_000,
    };
  };
  await compare("normal", () =>
    enforceOrgRateLimit(ORG, "completions", { config, userId: "normal" }),
  );
  await compare("cache-miss", (i) =>
    enforceOrgRateLimit(ORG, "completions", { userId: `e2e-miss-${i}` }),
  );
  await compare(
    "exhausted",
    () =>
      enforceOrgRateLimit(ORG, "completions", {
        config: exhaustedConfig,
        userId: "e2e-spent",
      }),
    () => exhaust("e2e-spent"),
  );
  // The ended window no longer matches the primary policy stamp, so the
  // existing fence answers "warming" (503) after its transaction in both runs.
  await compare("expired", () =>
    enforceOrgRateLimit(ORG, "completions", {
      config: expiredConfig,
      userId: "e2e-expired",
    }).catch((error: unknown) => {
      if (!(error instanceof OrgRateLimitCacheNotReadyError)) throw error;
    }),
  );

  // Part 3: Maps request admission.
  const maps = await setupMapsBench(exec);
  const mapsGate: Record<string, Summary> = {};
  const mapsAdmission: Record<string, Summary> = {};
  const measureMaps = async (
    name: string,
    options: { allowance?: number; freshGate?: boolean },
    expected: { gate: number; admission: number },
    gateRequest: () => MapsBenchRequest = maps.request,
    org = maps.org,
  ) => {
    maps.configure(options);
    mapsGate[name] = summarize(
      await time(E2E_ITERATIONS, async () => {
        const response = await maps.call(gateRequest());
        if (response.status !== expected.gate)
          throw new Error(`Maps gate ${name}: ${response.status}`);
      }),
    );
    maps.configure(options);
    mapsAdmission[name] = summarize(
      await time(E2E_ITERATIONS, (i) => maps.admit(i, org, expected.admission)),
    );
  };
  await measureMaps("normal", {}, { gate: 200, admission: 200 });
  // No stored allowance window: the first Maps request of a new gate.
  await measureMaps(
    "cache-miss",
    { freshGate: true },
    { gate: 200, admission: 200 },
  );
  await measureMaps(
    "exhausted",
    { allowance: 0 },
    { gate: 429, admission: 429 },
  );
  // The gate refuses a policy window that has ended (503). End to end, the
  // primary policy read finds no active entitlement and refuses before the
  // gate (403). PGlite cannot move the clock past a grant, so the ended
  // entitlement is a revoked grant: the same refusal path.
  await measureMaps(
    "expired",
    {},
    { gate: 503, admission: 403 },
    maps.expiredRequest,
    maps.endedOrg,
  );

  // Billing outage: the database is closed. The limiter stage and a refusal
  // still decide from memory. An admitted request continues to the existing
  // policy transaction, whose outage behavior this change does not alter.
  setLimiter(true);
  await exhaust("outage-spent");
  await database.closeDatabaseConnectionsForTests();
  const outageRefusal = summarize(
    await time(E2E_ITERATIONS, async () => {
      const response = await enforceOrgRateLimit(ORG, "completions", {
        config: exhaustedConfig,
        userId: "outage-spent",
      });
      if (response?.status !== 429)
        throw new Error("outage refusal did not return 429");
    }),
  );
  // After the end-to-end refusal: new accounts here would evict its bucket.
  stage["billing-outage"] = summarize(
    await time(STAGE_ITERATIONS, (i) =>
      stageCall({ organizationId: ORG, userId: `outage-${i}`, planKey }),
    ),
  );

  // Maps billing outage: the gate holds its own count and still answers; end
  // to end, the primary policy read fails, so admission refuses (no request is
  // admitted without the policy lock).
  maps.configure({});
  mapsGate["billing-outage"] = summarize(
    await time(E2E_ITERATIONS, async () => {
      const response = await maps.call(maps.request());
      if (response.status !== 200)
        throw new Error(`Maps gate billing-outage: ${response.status}`);
    }),
  );
  mapsAdmission["billing-outage"] = summarize(
    await time(E2E_ITERATIONS, (i) =>
      maps.admit(i, maps.org, "database-closed"),
    ),
  );

  const result = {
    issue: "https://github.com/AlphaCompute/alphaphone/issues/410",
    measuredAt: new Date().toISOString(),
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    unit: "milliseconds",
    note: "Local in-process measurement. PGlite has no network; production adds the policy transaction's real database round trip to both limiter-off and limiter-on rows. Bucket numbers are benchmark values, not selected limits.",
    limiterStage: stage,
    enforceOrgRateLimitPglite: e2e,
    billingOutageRefusalEndToEnd: outageRefusal,
    mapsNote:
      "Maps admission has no plan cache and no limiter-off mode: every admission holds the primary policy read lock through the gate call. callMapsRequestAllowance is the gate call alone; admitMapsRequest adds the policy lock. On PGlite the entitlement summary read inside the lock is served from a prior read (one connection), so add entitlementSummaryRead for the full admission. The gate runs in process on in-memory storage without its credential revocation read.",
    callMapsRequestAllowance: mapsGate,
    admitMapsRequestPglite: mapsAdmission,
    entitlementSummaryRead: maps.summaryRead,
  };
  const output = testOutputPath("plan-request-limit-latency", "results.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`wrote ${output}`);
}

/**
 * The policy read's failure in the outage run. After
 * `closeDatabaseConnectionsForTests` the client opens a new, empty in-memory
 * database on the next query, so the billing tables are missing: the read
 * fails as it would against an unavailable billing database.
 */
const DATABASE_CLOSED_PATTERN = /relation "organizations" does not exist/;

type MapsBenchRequest =
  import("../shared/src/lib/services/maps-request-policy").MapsAllowanceRequest;

/**
 * A subscription-grant organization on PGlite, plus one whose grant is
 * revoked, and an in-process Maps gate behind the cloud binding that
 * `callMapsRequestAllowance` reads.
 */
async function setupMapsBench(exec: (query: string) => Promise<void>) {
  const grants = await import(
    "../shared/src/db/repositories/subscription-grants"
  );
  const entitlementModule = await import(
    "../shared/src/lib/services/subscription-entitlement-token"
  );
  const { readOrganizationEntitlementSummary } = entitlementModule;
  const { runWithCloudBindingsAsync } = await import(
    "../shared/src/lib/runtime/cloud-bindings"
  );
  const { callMapsRequestAllowance } = await import(
    "../shared/src/lib/services/inference-admission-gate"
  );
  const { MapsRequestAllowanceController } = await import(
    "../api/src/maps-request-allowance-controller"
  );
  const { admitMapsRequest, MapsAdmissionError } = await import(
    "../api/src/lib/maps-request-admission"
  );
  const user = "63000000-0000-4000-8000-00000000a410";
  const pepper = "maps-latency-pepper-0123456789abcdef";
  // Grant buckets carry no invoice (production state from migration 0404).
  await exec(
    "ALTER TABLE subscription_allowance_periods ALTER COLUMN stripe_invoice_id DROP NOT NULL",
  );
  await exec(`INSERT INTO users(id) VALUES ('${user}')`);
  const subscriber = async (org: string, code: string) => {
    await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
      VALUES ('${org}', '0', 1, 0, '{}', true, false, 'active')`);
    const codeHash = await grants.hashSubscriptionGrantCode(
      grants.normalizeSubscriptionGrantCode(code) ?? code,
      pepper,
    );
    await exec(`INSERT INTO subscription_grant_codes(code_hash, family, max_redemptions, duration_days, requires_no_paid_plan)
      VALUES ('${codeHash}', 'alpha_phone', 1, 183, false)`);
    const { grant } = await grants.subscriptionGrantsRepository.redeem({
      organizationId: org,
      userId: user,
      codeHash,
      idempotencyKey: `maps-latency-${org}`,
    });
    return grant;
  };
  const org = "61000000-0000-4000-8000-00000000b410";
  const endedOrg = "61000000-0000-4000-8000-00000000c410";
  await subscriber(org, "MAPS-LATE-NCY0-0001");
  const ended = await subscriber(endedOrg, "MAPS-LATE-NCY0-0002");
  await grants.subscriptionGrantsRepository.revoke({
    grantId: ended.id,
    reason: "latency benchmark: ended entitlement",
  });
  const summary = await readOrganizationEntitlementSummary(org);
  if (summary.plan.status !== "active" || !summary.rateTier)
    throw new Error("Maps benchmark organization is not an active subscriber");
  const planKey = summary.rateTier;
  const summaries = new Map([
    [org, summary],
    [endedOrg, await readOrganizationEntitlementSummary(endedOrg)],
  ]);
  const summaryRead = summarize(
    await time(E2E_ITERATIONS, () => readOrganizationEntitlementSummary(org)),
  );
  // PGlite has one connection, so the entitlement summary's own transaction
  // cannot open while admission holds the policy read lock (it waits
  // forever). Serve the summary read above for the two benchmark
  // organizations; its cost is reported separately as `entitlementSummaryRead`.
  mock.module(
    "../shared/src/lib/services/subscription-entitlement-token",
    () => ({
      ...entitlementModule,
      readOrganizationEntitlementSummary: (
        organizationId: string,
        ...rest: [{ allowance?: boolean }?]
      ) =>
        summaries.get(organizationId) ??
        readOrganizationEntitlementSummary(organizationId, ...rest),
    }),
  );

  let gateEnv: Record<string, unknown> = {};
  let freshGate = false;
  const gates = new Map<string, MemoryDurableStorage>();
  const binding = {
    getByName: (name: string) => ({
      async fetch(request: Request): Promise<Response> {
        let storage = gates.get(name);
        if (!storage || freshGate) {
          storage = new MemoryDurableStorage();
          gates.set(name, storage);
        }
        return new MapsRequestAllowanceController(
          storage as unknown as DurableObjectStorage,
          gateEnv,
          { credential: async () => null },
        ).handle(new URL(request.url).pathname, await request.json());
      },
    }),
  };
  const bindings = { INFERENCE_ADMISSION_GATES: binding };
  process.env.INFERENCE_STRONG_REVOCATION_ENABLED = "true";

  const credential = {
    kind: "api_key" as const,
    credentialId: "maps-latency-key",
    userId: user,
  };
  let sequence = 0;
  const request = (): MapsBenchRequest => ({
    organizationId: org,
    requestId: `maps-${++sequence}`,
    operation: "search",
    credential: { ...credential, organizationId: org },
    policy: {
      generation: "1",
      planKey,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      effectiveUntil: null,
      subscriptionFunded: true,
    },
  });
  return {
    org,
    endedOrg,
    summaryRead,
    request,
    expiredRequest: (): MapsBenchRequest => {
      const base = request();
      return {
        ...base,
        policy: {
          ...base.policy,
          effectiveUntil: new Date(Date.now() - 1_000).toISOString(),
        },
      };
    },
    configure(options: { allowance?: number; freshGate?: boolean }) {
      freshGate = options.freshGate === true;
      gates.clear();
      gateEnv = {
        ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES: JSON.stringify({
          selected: true,
          plans: {
            [planKey]: {
              requests: options.allowance ?? 1_000_000_000,
              windowSeconds: 30 * 86_400,
            },
          },
        }),
        ELIZA_CLOUD_PLAN_RATE_LIMITS: JSON.stringify({
          selected: true,
          plans: {
            default: {
              burst: { capacity: 1_000_000, refillPerSecond: 1_000 },
              sustained: { capacity: 1_000_000, refillPerSecond: 1_000 },
            },
          },
        }),
      };
    },
    call: (value: MapsBenchRequest) =>
      runWithCloudBindingsAsync(bindings, () =>
        callMapsRequestAllowance(value),
      ),
    /**
     * Admit one request; `expected` is the HTTP status, or "database-closed"
     * for the closed-database failure of the policy read.
     */
    async admit(
      i: number,
      organizationId: string,
      expected: number | "database-closed",
    ) {
      const context = {
        req: {
          raw: { signal: new AbortController().signal },
          header: (name: string) =>
            name === "Idempotency-Key"
              ? `maps-admit-${++sequence}-${i}`
              : undefined,
        },
      } as unknown as Parameters<typeof admitMapsRequest>[0];
      let status: number | string = 200;
      try {
        await runWithCloudBindingsAsync(bindings, () =>
          admitMapsRequest(
            context,
            {
              id: user,
              organization_id: organizationId,
              credential: { ...credential },
            },
            "search",
          ),
        );
      } catch (error) {
        // Drizzle wraps the driver error as `cause` of "Failed query: ...".
        const cause = error instanceof Error ? error.cause : undefined;
        const message =
          cause instanceof Error
            ? cause.message
            : error instanceof Error
              ? error.message
              : String(error);
        status =
          error instanceof MapsAdmissionError
            ? error.status
            : DATABASE_CLOSED_PATTERN.test(message)
              ? "database-closed"
              : `untyped error: ${message}`;
      }
      if (status !== expected)
        throw new Error(`admitMapsRequest expected ${expected}, got ${status}`);
    },
  };
}

await main();
