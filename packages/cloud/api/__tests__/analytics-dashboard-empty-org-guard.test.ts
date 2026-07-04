/**
 * Dashboard + analytics page-load endpoints — empty-org 2xx guard and
 * warm-cache Date-rehydration guard (#13406).
 *
 * Two 500-classes are pinned here:
 *
 * 1. Brand-new org (zero usage, zero agents): GET /api/v1/dashboard,
 *    /api/analytics/overview, /api/analytics/breakdown and
 *    /api/analytics/projections must return 200 with zeroed/empty stats —
 *    no null-aggregate `.toISOString()`, no divide-by-zero NaN/Infinity in
 *    the JSON, no `.values([])` insert throw from the projections alert
 *    persistence.
 *
 * 2. Warm cache: `analyticsService.getUsageTimeSeries` caches
 *    TimeSeriesDataPoint[] through a JSON round-trip (Redis/KV), so on a
 *    cache HIT `timestamp` came back as an ISO STRING and the breakdown /
 *    projections routes threw `point.timestamp.toISOString is not a
 *    function` → 500. The time-series cache key embeds millisecond-precision
 *    ISO dates, so a hit needs two requests inside the same millisecond
 *    (duplicate concurrent page fetches) — reproduced here deterministically
 *    with a frozen clock. The fix rehydrates Dates at the service seam.
 *
 * Drives the REAL route modules + REAL analytics/dashboard services and
 * repositories against in-process PGlite (real SQL, real generated columns)
 * with the real cache client on the in-memory string-storing adapter
 * (MOCK_REDIS=1 — same JSON serialization as production Redis/KV). Only
 * auth, rate-limit, and the logger are stubbed.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { Hono } from "hono";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.MOCK_REDIS = "1";
process.env.NODE_ENV ||= "test";

const ORG_EMPTY = "00000000-0000-4000-8000-0000000000e1";
const USER_EMPTY = "00000000-0000-4000-8000-0000000000e2";
const ORG_ACTIVE = "00000000-0000-4000-8000-0000000000a1";
const USER_ACTIVE = "00000000-0000-4000-8000-0000000000a2";
const CHARACTER_ID = "00000000-0000-4000-8000-0000000000c1";
const PGLITE_TIMEOUT = 60000;

// The routes read the caller from requireUserOrApiKeyWithOrg; make it settable
// per test. Full (non-spread) module mock is safe here: cloud-api test files
// run one-per-process (test/run-unit-isolated.mjs) and this file's import
// graph only uses this one export from the auth module.
let currentUser: { id: string; role: string; organization_id: string };
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => currentUser,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

let dbWrite: typeof import("../../shared/src/db/client").dbWrite;
let closeDb:
  | typeof import("../../shared/src/db/client").closeDatabaseConnectionsForTests
  | undefined;
let app: Hono;
let pgliteReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import(
      "../../shared/src/db/client"
    ));
    const ddl = [
      `CREATE TABLE IF NOT EXISTS organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        credit_balance numeric(12,6) NOT NULL DEFAULT '0',
        settings jsonb DEFAULT '{}',
        stripe_customer_id text,
        billing_email text,
        stripe_payment_method_id text,
        stripe_default_payment_method text,
        auto_top_up_enabled boolean DEFAULT false,
        auto_top_up_threshold numeric(10,2),
        auto_top_up_amount numeric(10,2),
        pay_as_you_go_from_earnings boolean NOT NULL DEFAULT true,
        steward_tenant_id text UNIQUE,
        steward_tenant_api_key text,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text UNIQUE,
        name text,
        nickname text,
        organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
        role text NOT NULL DEFAULT 'member',
        steward_user_id text NOT NULL UNIQUE,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      // canonical_model / canonical_provider are real generated columns in
      // prod; mirror them so the breakdown GROUP BYs run the real SQL.
      `CREATE TABLE IF NOT EXISTS usage_records (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        api_key_id uuid,
        type text NOT NULL,
        model text,
        provider text NOT NULL,
        input_tokens integer NOT NULL DEFAULT 0,
        output_tokens integer NOT NULL DEFAULT 0,
        input_cost numeric(12,6) DEFAULT '0.000000',
        output_cost numeric(12,6) DEFAULT '0.000000',
        markup numeric(12,6) DEFAULT '0.000000',
        request_id text,
        duration_ms integer,
        is_successful boolean NOT NULL DEFAULT true,
        error_message text,
        ip_address text,
        user_agent text,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamp NOT NULL DEFAULT now(),
        canonical_model text GENERATED ALWAYS AS (CASE
          WHEN model IS NULL OR model = '' THEN '__null__'
          WHEN position('/' in model) > 0 THEN
            CASE
              WHEN model LIKE 'xai/%' THEN 'x-ai/' || substring(model from 5)
              WHEN model LIKE 'mistral/%' THEN 'mistralai/' || substring(model from 9)
              ELSE model
            END
          ELSE model
        END) STORED,
        canonical_provider text GENERATED ALWAYS AS (CASE provider
          WHEN 'x-ai' THEN 'xai'
          WHEN 'mistralai' THEN 'mistral'
          ELSE provider
        END) STORED
      )`,
      `CREATE TABLE IF NOT EXISTS analytics_alert_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        policy_id text NOT NULL,
        severity text NOT NULL,
        status text NOT NULL DEFAULT 'open',
        source text NOT NULL,
        title text NOT NULL,
        message text NOT NULL,
        evidence jsonb NOT NULL DEFAULT '{}',
        dedupe_key text NOT NULL,
        evaluated_at timestamp NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS analytics_alert_events_org_dedupe_unique
        ON analytics_alert_events (organization_id, dedupe_key)`,
      // Dashboard repo selects * on user_characters — full column set.
      `CREATE TABLE IF NOT EXISTS user_characters (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL,
        username text UNIQUE,
        system text,
        bio jsonb NOT NULL,
        message_examples jsonb DEFAULT '[]',
        post_examples jsonb DEFAULT '[]',
        topics jsonb DEFAULT '[]',
        adjectives jsonb DEFAULT '[]',
        knowledge jsonb DEFAULT '[]',
        plugins jsonb DEFAULT '[]',
        settings jsonb NOT NULL DEFAULT '{}',
        secrets jsonb DEFAULT '{}',
        style jsonb DEFAULT '{}',
        character_data jsonb NOT NULL,
        is_template boolean NOT NULL DEFAULT false,
        is_public boolean NOT NULL DEFAULT false,
        avatar_url text,
        category text,
        tags jsonb DEFAULT '[]',
        featured boolean NOT NULL DEFAULT false,
        view_count integer NOT NULL DEFAULT 0,
        interaction_count integer NOT NULL DEFAULT 0,
        popularity_score integer NOT NULL DEFAULT 0,
        source text NOT NULL DEFAULT 'cloud',
        token_address text,
        token_chain text,
        token_name text,
        token_ticker text,
        erc8004_registered boolean NOT NULL DEFAULT false,
        erc8004_network text,
        erc8004_agent_id integer,
        erc8004_agent_uri text,
        erc8004_tx_hash text,
        erc8004_registered_at timestamp,
        monetization_enabled boolean NOT NULL DEFAULT false,
        inference_markup_percentage numeric(7,2) NOT NULL DEFAULT '0.00',
        payout_wallet_address text,
        total_inference_requests integer NOT NULL DEFAULT 0,
        total_creator_earnings numeric(12,4) NOT NULL DEFAULT '0.0000',
        total_platform_revenue numeric(12,4) NOT NULL DEFAULT '0.0000',
        a2a_enabled boolean NOT NULL DEFAULT true,
        mcp_enabled boolean NOT NULL DEFAULT true,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      // Dashboard repo selects * on containers — full column set.
      `CREATE TABLE IF NOT EXISTS containers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        project_name text NOT NULL,
        description text,
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        api_key_id uuid,
        character_id uuid REFERENCES user_characters(id) ON DELETE SET NULL,
        load_balancer_url text,
        public_hostname text,
        status text NOT NULL DEFAULT 'pending',
        image_tag text,
        environment_vars jsonb DEFAULT '{}',
        desired_count integer NOT NULL DEFAULT 1,
        cpu integer NOT NULL DEFAULT 1792,
        memory integer NOT NULL DEFAULT 1792,
        port integer NOT NULL DEFAULT 3000,
        health_check_path text DEFAULT '/health',
        node_id text,
        volume_path text,
        volume_size_gb integer,
        hcloud_volume_id integer,
        volume_location text,
        last_deployed_at timestamp,
        last_health_check timestamp,
        deployment_log text,
        deployment_log_storage text NOT NULL DEFAULT 'inline',
        deployment_log_key text,
        error_message text,
        metadata jsonb NOT NULL DEFAULT '{}',
        last_billed_at timestamp,
        next_billing_at timestamp,
        billing_status text NOT NULL DEFAULT 'active',
        shutdown_warning_sent_at timestamp,
        scheduled_shutdown_at timestamp,
        total_billed numeric(10,2) NOT NULL DEFAULT '0.00',
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS eliza_room_characters (
        room_id uuid PRIMARY KEY,
        character_id uuid NOT NULL REFERENCES user_characters(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
    ];
    for (const stmt of ddl) await dbWrite.execute(stmt);

    // Mount the real route apps exactly as src/_router.generated.ts does.
    const [dashboard, overview, breakdown, projections] = await Promise.all([
      import("../v1/dashboard/route"),
      import("../analytics/overview/route"),
      import("../analytics/breakdown/route"),
      import("../analytics/projections/route"),
    ]);
    app = new Hono();
    app.route("/api/v1/dashboard", dashboard.default as unknown as Hono);
    app.route("/api/analytics/overview", overview.default as unknown as Hono);
    app.route("/api/analytics/breakdown", breakdown.default as unknown as Hono);
    app.route(
      "/api/analytics/projections",
      projections.default as unknown as Hono,
    );
  } catch (error) {
    pgliteReady = false;
    console.warn(
      "[analytics-dashboard-empty-org-guard] PGlite unavailable, skipping:",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  setSystemTime();
  if (closeDb) await closeDb();
});

beforeEach(async () => {
  if (!pgliteReady) return;
  setSystemTime();
  await dbWrite.execute(`DELETE FROM analytics_alert_events;`);
  await dbWrite.execute(`DELETE FROM usage_records;`);
  await dbWrite.execute(`DELETE FROM eliza_room_characters;`);
  await dbWrite.execute(`DELETE FROM containers;`);
  await dbWrite.execute(`DELETE FROM user_characters;`);
  await dbWrite.execute(`DELETE FROM users;`);
  await dbWrite.execute(`DELETE FROM organizations;`);
  await dbWrite.execute(
    `INSERT INTO organizations (id, name, slug) VALUES
       ('${ORG_EMPTY}', 'Brand New Org', 'brand-new-org'),
       ('${ORG_ACTIVE}', 'Active Org', 'active-org');`,
  );
  await dbWrite.execute(
    `INSERT INTO users (id, email, name, organization_id, role, steward_user_id) VALUES
       ('${USER_EMPTY}', 'new@example.com', 'New User', '${ORG_EMPTY}', 'owner', 'steward-new'),
       ('${USER_ACTIVE}', 'active@example.com', 'Active User', '${ORG_ACTIVE}', 'owner', 'steward-active');`,
  );
  currentUser = { id: USER_EMPTY, role: "owner", organization_id: ORG_EMPTY };
});

async function get(path: string): Promise<Response> {
  return await app.fetch(new Request(`http://test.local${path}`));
}

/** Seed daily usage for ORG_ACTIVE at now-1d..now-4d (inside every window). */
async function seedActiveUsage(): Promise<void> {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const values = [1, 2, 3, 4]
    .map((daysAgo) => {
      const at = new Date(now - daysAgo * day).toISOString();
      return `('${ORG_ACTIVE}', '${USER_ACTIVE}', 'inference', 'gpt-4o', 'openai',
        ${100 * daysAgo}, ${50 * daysAgo}, '0.010000', '0.020000', true, '${at}')`;
    })
    .join(",");
  await dbWrite.execute(
    `INSERT INTO usage_records (organization_id, user_id, type, model, provider,
       input_tokens, output_tokens, input_cost, output_cost, is_successful, created_at)
     VALUES ${values};`,
  );
}

/** Recursively assert no NaN/Infinity leaked into a JSON payload's numbers. */
function assertFiniteNumbers(value: unknown, path = "$"): void {
  if (typeof value === "number") {
    expect(Number.isFinite(value), `${path} is not finite`).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      assertFiniteNumbers(item, `${path}[${i}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assertFiniteNumbers(nested, `${path}.${key}`);
    }
  }
}

describe("brand-new org (zero usage, zero agents) gets zeroed 2xx stats", () => {
  test(
    "GET /api/v1/dashboard returns 200 with an empty agents list",
    async () => {
      if (!pgliteReady) throw new Error("PGlite required for this suite");
      const res = await get("/api/v1/dashboard");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        user: { name: string };
        agents: unknown[];
      };
      expect(body.success).toBe(true);
      expect(body.user.name).toBe("New User");
      expect(body.agents).toEqual([]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "GET /api/v1/dashboard returns 200 for a draft agent with zero rooms/messages/deployments",
    async () => {
      if (!pgliteReady) throw new Error("PGlite required for this suite");
      await dbWrite.execute(
        `INSERT INTO user_characters (id, organization_id, user_id, name, bio, character_data)
         VALUES ('${CHARACTER_ID}', '${ORG_EMPTY}', '${USER_EMPTY}', 'First Agent',
                 '"a brand new agent"', '{}');`,
      );
      const res = await get("/api/v1/dashboard");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        agents: Array<{ id: string; stats?: { lastActiveAt: string | null } }>;
      };
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].id).toBe(CHARACTER_ID);
      // No containers/rooms/messages: stats are omitted, never a null-MAX throw.
      expect(body.agents[0].stats).toBeUndefined();
    },
    PGLITE_TIMEOUT,
  );

  test(
    "GET /api/analytics/overview returns 200 zeroed summary with finite numbers",
    async () => {
      if (!pgliteReady) throw new Error("PGlite required for this suite");
      const res = await get("/api/analytics/overview?timeRange=daily");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: Record<string, unknown>;
      };
      expect(body.success).toBe(true);
      expect(body.data.totalRequests).toBe(0);
      expect(body.data.successfulRequests).toBe(0);
      expect(body.data.failedRequests).toBe(0);
      expect(body.data.totalCost).toBe(0);
      expect(body.data.avgCostPerRequest).toBe(0);
      expect(body.data.avgTokensPerRequest).toBe(0);
      expect(body.data.totalTokens).toBe(0);
      expect(typeof body.data.periodStart).toBe("string");
      expect(typeof body.data.periodEnd).toBe("string");
      assertFiniteNumbers(body.data);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "GET /api/analytics/breakdown returns 200 with empty series and null runway",
    async () => {
      if (!pgliteReady) throw new Error("PGlite required for this suite");
      const res = await get("/api/analytics/breakdown?timeRange=weekly");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          overallStats: { totalRequests: number; totalCost: number };
          timeSeriesData: unknown[];
          providerBreakdown: unknown[];
          modelBreakdown: unknown[];
          costTrending: {
            currentDailyBurn: number;
            daysUntilBalanceZero: number | null;
            monthlyBurnPercent: number;
          };
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.overallStats.totalRequests).toBe(0);
      expect(body.data.overallStats.totalCost).toBe(0);
      expect(body.data.timeSeriesData).toEqual([]);
      expect(body.data.providerBreakdown).toEqual([]);
      expect(body.data.modelBreakdown).toEqual([]);
      expect(body.data.costTrending.currentDailyBurn).toBe(0);
      expect(body.data.costTrending.daysUntilBalanceZero).toBeNull();
      expect(body.data.costTrending.monthlyBurnPercent).toBe(0);
      assertFiniteNumbers(body.data);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "GET /api/analytics/projections returns 200 with empty history/projections/alerts",
    async () => {
      if (!pgliteReady) throw new Error("PGlite required for this suite");
      const res = await get("/api/analytics/projections");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          historicalData: unknown[];
          projections: unknown[];
          alerts: unknown[];
          alertEvents: unknown[];
          creditBalance: number;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.historicalData).toEqual([]);
      expect(body.data.projections).toEqual([]);
      expect(body.data.alerts).toEqual([]);
      expect(body.data.alertEvents).toEqual([]);
      expect(body.data.creditBalance).toBe(0);
      assertFiniteNumbers(body.data);
    },
    PGLITE_TIMEOUT,
  );
});

describe("warm time-series cache must not 500 (Date survives the JSON round-trip)", () => {
  test(
    "GET /api/analytics/breakdown twice at the same clock millisecond stays 200",
    async () => {
      if (!pgliteReady) throw new Error("PGlite required for this suite");
      currentUser = {
        id: USER_ACTIVE,
        role: "owner",
        organization_id: ORG_ACTIVE,
      };
      await seedActiveUsage();

      // Freeze the clock so both requests compute identical date ranges and
      // therefore identical cache keys — the second request is a cache HIT,
      // the state that made `point.timestamp.toISOString()` throw.
      setSystemTime(new Date());
      try {
        const first = await get("/api/analytics/breakdown?timeRange=weekly");
        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as {
          data: {
            timeSeriesData: Array<{ timestamp: string; totalRequests: number }>;
          };
        };
        expect(firstBody.data.timeSeriesData.length).toBeGreaterThanOrEqual(3);

        const second = await get("/api/analytics/breakdown?timeRange=weekly");
        expect(second.status).toBe(200);
        const secondBody = (await second.json()) as {
          data: {
            timeSeriesData: Array<{ timestamp: string; totalRequests: number }>;
          };
        };
        expect(secondBody.data.timeSeriesData).toEqual(
          firstBody.data.timeSeriesData,
        );
        for (const point of secondBody.data.timeSeriesData) {
          expect(Number.isNaN(Date.parse(point.timestamp))).toBe(false);
        }
      } finally {
        setSystemTime();
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "GET /api/analytics/projections twice at the same clock millisecond stays 200",
    async () => {
      if (!pgliteReady) throw new Error("PGlite required for this suite");
      currentUser = {
        id: USER_ACTIVE,
        role: "owner",
        organization_id: ORG_ACTIVE,
      };
      await seedActiveUsage();

      setSystemTime(new Date());
      try {
        const first = await get("/api/analytics/projections?periods=7");
        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as {
          data: {
            historicalData: unknown[];
            projections: Array<{ isProjected: boolean }>;
          };
        };
        expect(firstBody.data.historicalData.length).toBeGreaterThanOrEqual(3);
        expect(firstBody.data.projections.some((p) => p.isProjected)).toBe(
          true,
        );

        // Cache HIT: the projection math calls `.getTime()` on every
        // historical timestamp before the response mapping even runs.
        const second = await get("/api/analytics/projections?periods=7");
        expect(second.status).toBe(200);
        const secondBody = (await second.json()) as {
          data: {
            historicalData: Array<{ timestamp: string }>;
            projections: Array<{ isProjected: boolean }>;
          };
        };
        expect(secondBody.data.projections.some((p) => p.isProjected)).toBe(
          true,
        );
        for (const point of secondBody.data.historicalData) {
          expect(Number.isNaN(Date.parse(point.timestamp))).toBe(false);
        }
      } finally {
        setSystemTime();
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "analyticsService.getUsageByUser returns Date lastActive on a cache hit",
    async () => {
      if (!pgliteReady) throw new Error("PGlite required for this suite");
      await seedActiveUsage();
      const { analyticsService } = await import("@/lib/services/analytics");

      // Fixed explicit dates → identical cache key across both calls without
      // touching the clock; second call is served from the cache.
      const options = {
        startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        endDate: new Date(),
        limit: 10,
      };
      const miss = await analyticsService.getUsageByUser(ORG_ACTIVE, options);
      expect(miss).toHaveLength(1);
      expect(miss[0].lastActive).toBeInstanceOf(Date);

      const hit = await analyticsService.getUsageByUser(ORG_ACTIVE, options);
      expect(hit).toHaveLength(1);
      expect(hit[0].lastActive).toBeInstanceOf(Date);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "GET /api/analytics/overview twice (stable cache key) stays 200 with equal payloads",
    async () => {
      if (!pgliteReady) throw new Error("PGlite required for this suite");
      currentUser = {
        id: USER_ACTIVE,
        role: "owner",
        organization_id: ORG_ACTIVE,
      };
      await seedActiveUsage();

      const first = await get("/api/analytics/overview?timeRange=weekly");
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        data: Record<string, unknown>;
      };
      expect(firstBody.data.totalRequests).toBe(4);

      // The overview cache key has no date component, so the second request
      // is always a warm hit even without freezing the clock.
      const second = await get("/api/analytics/overview?timeRange=weekly");
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as {
        data: Record<string, unknown>;
      };
      expect(secondBody.data.totalRequests).toBe(4);
      assertFiniteNumbers(secondBody.data);
    },
    PGLITE_TIMEOUT,
  );
});
