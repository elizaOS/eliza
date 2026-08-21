/**
 * Tests for the admin integration reliability route: super_admin gate,
 * dashboard payload shape (dashboard + runbook + invalidConfig from env
 * config), telemetry ingest validation/idempotency, and the no-secrets
 * redaction audit on the served payload. Auth, logging, and rate limiting
 * are mocked; the reliability domain module is the real implementation.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import {
  findSecretLeaksInPayload,
  integrationTelemetryRecorder,
} from "@/lib/integrations/reliability";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, err: unknown) => {
    throw err;
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const requireAdmin = mock(async () => ({
  id: "admin-1",
  organization_id: "org-1",
  role: "super_admin",
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({ requireAdmin }));

const envStore: Record<string, string | undefined> = {};
mock.module("@/lib/runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => envStore,
}));

const { default: route } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/admin/integrations/reliability", route);
  return app;
}

function get() {
  return buildApp().request("/api/v1/admin/integrations/reliability");
}

function postEvents(body: unknown) {
  return buildApp().request("/api/v1/admin/integrations/reliability/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validEvent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    provider: "plaid",
    kind: "capability_call",
    outcome: "success",
    occurredAt: "2026-08-20T11:00:00.000Z",
    latencyMs: 90,
    costMicros: 10,
    ...overrides,
  };
}

describe("/api/v1/admin/integrations/reliability", () => {
  beforeEach(() => {
    requireAdmin.mockClear();
    requireAdmin.mockResolvedValue({
      id: "admin-1",
      organization_id: "org-1",
      role: "super_admin",
    });
    integrationTelemetryRecorder.clear();
    delete envStore.INTEGRATION_KILL_SWITCHES;
    delete envStore.INTEGRATION_RELEASE_EVIDENCE;
  });

  test("GET rejects non-super_admin", async () => {
    requireAdmin.mockResolvedValueOnce({
      id: "admin-2",
      organization_id: "org-1",
      role: "admin",
    });
    const response = await get();
    expect(response.status).toBe(403);
  });

  test("GET returns designed-empty dashboard with runbook", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: {
        dashboard: { providers: unknown[]; alerts: unknown[] };
        runbook: { id: string }[];
        invalidConfig: { killSwitches: string[]; releaseEvidence: string[] };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.dashboard.providers).toEqual([]);
    expect(body.data.runbook.length).toBeGreaterThanOrEqual(8);
    expect(body.data.invalidConfig).toEqual({
      killSwitches: [],
      releaseEvidence: [],
    });
  });

  test("POST then GET reflects ingested telemetry, kill switches, and evidence", async () => {
    envStore.INTEGRATION_KILL_SWITCHES = JSON.stringify([
      { provider: "stripe", reason: "incident 7" },
    ]);
    envStore.INTEGRATION_RELEASE_EVIDENCE = JSON.stringify([
      { provider: "plaid", status: "verified", reference: "#19908" },
    ]);
    const ingest = await postEvents([
      validEvent("a"),
      validEvent("b", { outcome: "failure", kind: "oauth_error" }),
    ]);
    expect(ingest.status).toBe(200);
    const ingestBody = (await ingest.json()) as {
      recorded: number;
      duplicates: number;
      rejected: unknown[];
    };
    expect(ingestBody).toMatchObject({
      recorded: 2,
      duplicates: 0,
      rejected: [],
    });

    const response = await get();
    const body = (await response.json()) as {
      data: {
        dashboard: {
          providers: {
            provider: string;
            health: string;
            counts: { oauthErrors: number };
            killSwitches: unknown[];
            evidence: { status: string } | null;
          }[];
        };
      };
    };
    const providers = Object.fromEntries(
      body.data.dashboard.providers.map((p) => [p.provider, p]),
    );
    expect(providers.plaid.counts.oauthErrors).toBe(1);
    expect(providers.plaid.evidence?.status).toBe("verified");
    expect(providers.stripe.health).toBe("disabled");
    expect(providers.stripe.killSwitches).toHaveLength(1);
  });

  test("GET surfaces malformed operator config as invalidConfig", async () => {
    envStore.INTEGRATION_KILL_SWITCHES = "{not json";
    envStore.INTEGRATION_RELEASE_EVIDENCE = JSON.stringify([
      { provider: "x!" },
    ]);
    const response = await get();
    const body = (await response.json()) as {
      data: {
        invalidConfig: { killSwitches: string[]; releaseEvidence: string[] };
      };
    };
    expect(body.data.invalidConfig.killSwitches).toEqual(["config_not_json"]);
    expect(body.data.invalidConfig.releaseEvidence).toEqual([
      "entry_0_invalid_provider",
    ]);
  });

  test("POST is idempotent per event id", async () => {
    await postEvents([validEvent("dup")]);
    const second = await postEvents([validEvent("dup")]);
    const body = (await second.json()) as {
      recorded: number;
      duplicates: number;
    };
    expect(body).toMatchObject({ recorded: 0, duplicates: 1 });
  });

  test("POST reports malformed events per-index; all-invalid is a 400", async () => {
    const mixed = await postEvents([validEvent("ok"), { id: "bad" }]);
    expect(mixed.status).toBe(200);
    const mixedBody = (await mixed.json()) as {
      recorded: number;
      rejected: { index: number; code: string }[];
    };
    expect(mixedBody.recorded).toBe(1);
    expect(mixedBody.rejected[0]).toMatchObject({ index: 1 });

    const allBad = await postEvents([{ nope: true }]);
    expect(allBad.status).toBe(400);
  });

  test("POST rejects non-JSON bodies and oversized batches", async () => {
    const nonJson = await postEvents("{oops");
    expect(nonJson.status).toBe(400);
    const oversized = await postEvents(
      Array.from({ length: 501 }, (_, i) => validEvent(`e${i}`)),
    );
    expect(oversized.status).toBe(400);
  });

  test("POST gate: non-super_admin cannot ingest", async () => {
    requireAdmin.mockResolvedValueOnce({
      id: "admin-2",
      organization_id: "org-1",
      role: "admin",
    });
    const response = await postEvents([validEvent("z")]);
    expect(response.status).toBe(403);
  });

  test("redaction audit: served dashboard contains no secret-shaped strings", async () => {
    await postEvents([
      validEvent("hostile", {
        outcome: "failure",
        kind: "oauth_error",
        code: "refresh token=sk-verysecret1234567890",
        detail: "Bearer aaaaaaaaaaaaaaaaaaaa for victim@example.com",
      }),
    ]);
    const response = await get();
    const body = await response.json();
    expect(findSecretLeaksInPayload(body)).toEqual([]);
  });
});
