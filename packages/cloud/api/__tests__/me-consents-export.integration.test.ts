/**
 * Drives the consent ledger and live data-export routes on real PGlite:
 * latest-per-purpose reads, audit written in the consent transaction (and
 * rolled back with it), the read-only model-call recording disclosure, and
 * the explicit 413.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const USER_ID = "00000000-0000-4000-8000-0000000000b1";
const PGLITE_TIMEOUT_MS = 60_000;
const ORIGIN = { origin: "http://localhost:3000", host: "localhost" };
const WORKER_ENV = { NODE_ENV: "test" } as never;

const passthrough: MiddlewareHandler = async (_c, next) => {
  await next();
};
const rateLimitActual = await import(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare"
);
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    ...rateLimitActual,
    rateLimit: () => passthrough,
  }),
);
const authActual = await import("@elizaos/cloud-shared/auth");
const TEST_USER = {
  id: USER_ID,
  organization_id: ORG_ID,
  organization: { id: ORG_ID, is_active: true },
};
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...authActual,
  requireUserWithOrg: async () => TEST_USER,
  requireRecentSessionUserWithOrg: async () => TEST_USER,
}));

let dbWrite: typeof import("@elizaos/cloud-shared/db/helpers").dbWrite;
let closeDatabaseConnectionsForTests: typeof import("@elizaos/cloud-shared/db/client").closeDatabaseConnectionsForTests;
let consentsRoute: typeof import("../v1/me/consents/route").default;
let createDataExportRoute: typeof import("../v1/me/data-export/route").createDataExportRoute;
let auditEventsSink: typeof import("../src/services/audit-events").auditEventsSink;
let AccountDeletionExportError: typeof import("@elizaos/cloud-shared/lib/services/account-deletion-export").AccountDeletionExportError;

beforeAll(async () => {
  ({ dbWrite } = await import("@elizaos/cloud-shared/db/helpers"));
  ({ closeDatabaseConnectionsForTests } = await import(
    "@elizaos/cloud-shared/db/client"
  ));
  consentsRoute = (await import("../v1/me/consents/route")).default;
  ({ createDataExportRoute } = await import("../v1/me/data-export/route"));
  ({ auditEventsSink } = await import("../src/services/audit-events"));
  ({ AccountDeletionExportError } = await import(
    "@elizaos/cloud-shared/lib/services/account-deletion-export"
  ));
  const { initAuditDispatcher } = await import(
    "../src/services/audit-dispatcher-singleton"
  );
  initAuditDispatcher([auditEventsSink]);

  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS user_consents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL, organization_id uuid NOT NULL,
      purpose text NOT NULL, granted boolean NOT NULL,
      policy_version text NOT NULL, source text NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS auth_events (
      event_id uuid PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(),
      actor_type text NOT NULL, actor_id text NOT NULL, action text NOT NULL,
      result text NOT NULL, resource_type text, resource_id text, ip text,
      ua text, request_id text, org_id text, metadata jsonb,
      expires_at timestamptz NOT NULL DEFAULT now() + interval '7 years'
    )
  `);
}, PGLITE_TIMEOUT_MS);

afterEach(async () => {
  mock.restore();
  delete process.env.LLM_TRAJECTORY_CAPTURE;
  delete process.env.LLM_TRAJECTORY_RETENTION_DAYS;
  await dbWrite.execute(sql`DELETE FROM user_consents`);
  await dbWrite.execute(sql`DELETE FROM auth_events`);
});

afterAll(async () => {
  await dbWrite.execute(sql`DROP TABLE IF EXISTS user_consents`);
  await dbWrite.execute(sql`DROP TABLE IF EXISTS auth_events`);
  await closeDatabaseConnectionsForTests();
}, PGLITE_TIMEOUT_MS);

function postConsent(body: unknown) {
  return consentsRoute.request(
    "http://localhost/",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...ORIGIN },
      body: JSON.stringify(body),
    },
    WORKER_ENV,
  );
}

async function auditActions(): Promise<string[]> {
  const result = (await dbWrite.execute(
    sql`SELECT action FROM auth_events ORDER BY ts`,
  )) as { rows: Array<{ action: string }> };
  return result.rows.map((row) => row.action);
}

type ConsentsBody = {
  consents: Array<{ purpose: string; granted: boolean }>;
  effective: Array<{
    purpose: string;
    granted: boolean;
    basis: string;
    defaultGranted: boolean;
  }>;
  capture: {
    modelCallRecording: {
      enabled: boolean;
      source: string;
      retentionDays: number;
    };
  };
};

async function readConsents(): Promise<ConsentsBody> {
  const response = await consentsRoute.request(
    "http://localhost/",
    undefined,
    WORKER_ENV,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as ConsentsBody;
}

describe("/api/v1/me/consents", () => {
  test(
    "POST records a decision with its audit event and GET returns the latest per purpose",
    async () => {
      const first = await postConsent({
        purpose: "vision_capture",
        granted: true,
        policyVersion: "2026-09",
      });
      expect(first.status).toBe(201);
      const created = (await first.json()) as {
        consent: Record<string, unknown>;
      };
      expect(created.consent).toMatchObject({
        purpose: "vision_capture",
        granted: true,
        policyVersion: "2026-09",
        source: "api",
      });
      expect(typeof created.consent.recordedAt).toBe("string");

      await postConsent({
        purpose: "vision_capture",
        granted: false,
        policyVersion: "2026-09",
      });
      const body = await readConsents();
      expect(body.consents).toEqual([
        expect.objectContaining({ purpose: "vision_capture", granted: false }),
      ]);
      expect(body.effective).toEqual([
        {
          purpose: "vision_capture",
          granted: false,
          basis: "recorded",
          defaultGranted: false,
        },
      ]);
      expect(await auditActions()).toEqual([
        "consent.granted",
        "consent.revoked",
      ]);
    },
    PGLITE_TIMEOUT_MS,
  );

  test(
    "GET discloses the deployment recording policy without a consent purpose",
    async () => {
      const unset = await readConsents();
      expect(unset.consents).toEqual([]);
      expect(unset.effective).toEqual([
        {
          purpose: "vision_capture",
          granted: false,
          basis: "default",
          defaultGranted: false,
        },
      ]);
      // NODE_ENV=test is non-production: recording defaults on.
      expect(unset.capture).toEqual({
        modelCallRecording: {
          enabled: true,
          source: "deployment-default",
          retentionDays: 90,
        },
      });

      process.env.LLM_TRAJECTORY_CAPTURE = "off";
      process.env.LLM_TRAJECTORY_RETENTION_DAYS = "30";
      expect((await readConsents()).capture).toEqual({
        modelCallRecording: {
          enabled: false,
          source: "explicit",
          retentionDays: 30,
        },
      });

      process.env.LLM_TRAJECTORY_CAPTURE = "sometimes";
      const invalid = await consentsRoute.request(
        "http://localhost/",
        undefined,
        WORKER_ENV,
      );
      expect(invalid.status).toBeGreaterThanOrEqual(500);
    },
    PGLITE_TIMEOUT_MS,
  );

  test(
    "a failed audit write records no consent",
    async () => {
      spyOn(auditEventsSink, "emitInTransaction").mockImplementation(
        async () => {
          throw new Error("auth_events unavailable");
        },
      );
      const response = await postConsent({
        purpose: "vision_capture",
        granted: true,
        policyVersion: "2026-09",
      });
      expect(response.status).toBeGreaterThanOrEqual(500);
      const count = (await dbWrite.execute(
        sql`SELECT count(*)::int AS n FROM user_consents`,
      )) as { rows: Array<{ n: number }> };
      expect(count.rows[0].n).toBe(0);
    },
    PGLITE_TIMEOUT_MS,
  );

  test(
    "rejects cross-site writes and unknown purposes",
    async () => {
      const crossSite = await consentsRoute.request(
        "http://localhost/",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://evil.example",
            host: "localhost",
          },
          body: JSON.stringify({
            purpose: "vision_capture",
            granted: true,
            policyVersion: "1",
          }),
        },
        WORKER_ENV,
      );
      expect(crossSite.status).toBe(403);
      for (const purpose of ["marketing", "trajectory_training"]) {
        const unknown = await postConsent({
          purpose,
          granted: true,
          policyVersion: "1",
        });
        expect(unknown.status).toBe(400);
      }
    },
    PGLITE_TIMEOUT_MS,
  );
});

describe("POST /api/v1/me/data-export", () => {
  function postExport(route: ReturnType<typeof createDataExportRoute>) {
    return route.request(
      "http://localhost/",
      {
        method: "POST",
        headers: ORIGIN,
      },
      WORKER_ENV,
    );
  }

  test(
    "returns the portable export and audits data.export",
    async () => {
      const bytes = new TextEncoder().encode(
        '{"format":"eliza-account-export-v1"}',
      );
      const collected: Array<Record<string, unknown>> = [];
      const route = createDataExportRoute({
        collect: async (input) => {
          collected.push(input);
          return bytes;
        },
      });
      const response = await postExport(route);
      expect(response.status).toBe(200);
      // A live export never includes other organization members' rows.
      expect(collected).toHaveLength(1);
      expect(collected[0]).toMatchObject({
        userId: USER_ID,
        organizationId: ORG_ID,
        subjectScope: "user",
      });
      expect(response.headers.get("content-disposition")).toContain(
        "eliza-account-export.json",
      );
      expect(response.headers.get("x-account-deletion-export-sha256")).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(await response.text()).toBe(
        '{"format":"eliza-account-export-v1"}',
      );
      expect(await auditActions()).toEqual(["data.export"]);
    },
    PGLITE_TIMEOUT_MS,
  );

  test(
    "an oversized account is an explicit 413 EXPORT_TOO_LARGE, never a truncated export",
    async () => {
      const route = createDataExportRoute({
        collect: async () => {
          throw new AccountDeletionExportError(
            "Account export requires a streamed support export",
            "EXPORT_TOO_LARGE",
          );
        },
      });
      const response = await postExport(route);
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ code: "EXPORT_TOO_LARGE" });
      expect(await auditActions()).toEqual([]);
    },
    PGLITE_TIMEOUT_MS,
  );
});
