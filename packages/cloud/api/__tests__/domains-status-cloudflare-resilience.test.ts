// Exercises cloud API tests domains status cloudflare resilience.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

/**
 * Regression test for the resilience bug in
 * `v1/apps/[id]/domains/status/route.ts`.
 *
 * The route loads the stored managed-domain row and then called
 * `cloudflareRegistrarService.getRegistrationStatus()` UNGUARDED, so any
 * transient Cloudflare failure (timeout, 5xx, rate-limit) threw to the outer
 * catch and returned a 5xx — even though the handler already held the stored
 * row and the response shape falls back to stored fields (`live?.status ??
 * md.status`). The fix wraps only that call: on failure it warns and keeps
 * `live = null`, so a status read degrades to the last-known stored state
 * with a 200. These tests drive the real route control flow (only its
 * collaborators are mocked) and assert both the degraded path and the
 * live-data-wins control.
 */

// --- collaborator mocks --------------------------------------------------

const requireUserOrApiKeyWithOrg =
  mock<() => Promise<{ organization_id: string }>>();

const getById = mock();
const isAppKeyOutOfScope = mock<() => Promise<boolean>>();
const getOwnDomainRow = mock();
const getRegistrationStatus = mock();
const loggerWarn = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope,
}));

mock.module("@/lib/services/apps", () => ({
  appsService: { getById },
}));

mock.module("@/lib/services/managed-domains", () => ({
  managedDomainsService: { getOwnDomainRow },
}));

mock.module("@/lib/services/cloudflare-registrar", () => ({
  cloudflareRegistrarService: { getRegistrationStatus },
}));

mock.module("@/lib/utils/error-handling", () => ({
  extractErrorMessage: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(),
    warn: loggerWarn,
    error: mock(),
    debug: mock(),
  },
}));

// Pre-fix, the Cloudflare throw escaped to the outer catch and landed here —
// the regression assertion below (200, stored fields) fails against this 500.
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (b: unknown, s: number) => unknown }) =>
    c.json({ success: false, error: "unhandled" }, 500),
}));

const { default: statusRoute } = await import(
  "../v1/apps/[id]/domains/status/route"
);

const app = new Hono();
app.route("/api/v1/apps/:id/domains/status", statusRoute);

const storedExpiresAt = new Date("2027-01-01T00:00:00.000Z");
const storedRow = {
  id: "md-1",
  organizationId: "org-1",
  appId: "app-1",
  domain: "example.com",
  registrar: "cloudflare",
  status: "active",
  verified: true,
  sslStatus: "active",
  expiresAt: storedExpiresAt,
};

function status(domain = "example.com", appId = "app-1") {
  return app.request(`/api/v1/apps/${appId}/domains/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain }),
  });
}

describe("POST /apps/:id/domains/status — Cloudflare blip degrades to stored state", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockReset();
    requireUserOrApiKeyWithOrg.mockResolvedValue({ organization_id: "org-1" });

    getById.mockReset();
    getById.mockResolvedValue({ id: "app-1", organization_id: "org-1" });

    isAppKeyOutOfScope.mockReset();
    isAppKeyOutOfScope.mockResolvedValue(false);

    getOwnDomainRow.mockReset();
    getOwnDomainRow.mockResolvedValue({ ...storedRow });

    getRegistrationStatus.mockReset();
    loggerWarn.mockClear();
  });

  test("cloudflare throws → 200 with the STORED md fields, not a 5xx", async () => {
    getRegistrationStatus.mockRejectedValue(
      new Error("cloudflare 503: upstream timeout"),
    );

    const res = await status();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      domain: "example.com",
      registrar: "cloudflare",
      status: "active", // stored md.status, since live is unavailable
      verified: true,
      sslStatus: "active",
      expiresAt: storedExpiresAt.toISOString(),
      live: null,
    });
    expect(getRegistrationStatus).toHaveBeenCalledTimes(1);
    expect(getRegistrationStatus).toHaveBeenCalledWith("example.com");
    // The degradation is observable: a structured warn, not a silent swallow.
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  test("control: cloudflare returns live data → live status wins over stored", async () => {
    getOwnDomainRow.mockResolvedValue({ ...storedRow, status: "pending" });
    getRegistrationStatus.mockResolvedValue({
      status: "active",
      completedAt: "2026-07-01T00:00:00.000Z",
      failureReason: null,
    });

    const res = await status();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      status: "active", // live.status, not the stored "pending"
      live: {
        status: "active",
        completedAt: "2026-07-01T00:00:00.000Z",
        failureReason: null,
      },
    });
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  test("external registrar never calls cloudflare and returns stored fields", async () => {
    getOwnDomainRow.mockResolvedValue({
      ...storedRow,
      registrar: "external",
      status: "pending",
      verified: false,
    });

    const res = await status();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      registrar: "external",
      status: "pending",
      verified: false,
      live: null,
    });
    expect(getRegistrationStatus).not.toHaveBeenCalled();
  });
});
