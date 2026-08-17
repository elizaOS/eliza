/**
 * Verifies the auto-top-up cutover routes with mocked auth, limiter, logging,
 * and service boundaries. The harness is deterministic and never opens a
 * database connection or loads Stripe.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import {
  AuthenticationError,
  ForbiddenError,
} from "@/lib/api/cloud-worker-errors";
import type { Bindings } from "@/types/cloud-worker-env";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000207";
const MANUAL_PATH = "/api/auto-top-up/trigger";
const CRON_PATH = "/api/cron/auto-top-up";
const CRON_SECRET = "auto-top-up-cutover-test-secret";
const PAUSED_AT = new Date("2026-08-17T12:00:00.000Z");

const requireUserOrApiKeyWithOrg = mock(async () => ({
  organization_id: ORGANIZATION_ID,
}));
const requireCronSecret = mock(
  (context: {
    env: { CRON_SECRET?: string };
    req: { header(name: string): string | undefined };
  }) => {
    const expected = context.env.CRON_SECRET;
    if (!expected) throw ForbiddenError("Cron secret not configured");
    const provided =
      context.req.header("authorization")?.replace(/^Bearer\s+/i, "") ||
      context.req.header("x-cron-secret") ||
      "";
    if (provided !== expected) throw AuthenticationError("Invalid cron secret");
  },
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
  requireCronSecret,
}));

const STRICT_RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 } as const;
const rateLimitConfigs: Array<Record<string, unknown>> = [];
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: STRICT_RATE_LIMIT },
  rateLimit: (config: Record<string, unknown>) => {
    rateLimitConfigs.push(config);
    return async (_context: unknown, next: () => Promise<void>) => next();
  },
}));

const executeAutoTopUpForOrganization = mock(
  async (_organizationId: string) => ({
    organizationId: ORGANIZATION_ID,
    success: false as const,
    status: "cutover_paused" as const,
    error:
      "Auto top-up charging is paused while the durable processor is rolled out",
  }),
);
const checkAndExecuteAutoTopUps = mock(async () => ({
  timestamp: PAUSED_AT,
  cutoverPaused: true as const,
  controlMode: "paused" as const,
  organizationsChecked: 0 as const,
  organizationsProcessed: 0 as const,
  successful: 0 as const,
  failed: 0 as const,
  results: [] as [],
}));

mock.module("@/lib/services/auto-top-up", () => ({
  autoTopUpService: {
    executeAutoTopUpForOrganization,
    checkAndExecuteAutoTopUps,
  },
}));

const logInfo = mock(() => undefined);
const logError = mock(() => undefined);
mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    info: logInfo,
    warn: mock(() => undefined),
    error: logError,
  },
}));

const manualRoute = (await import("../auto-top-up/trigger/route")).default;
const cronRoute = (await import("../cron/auto-top-up/route")).default;

function makeApp(path: string, route: typeof manualRoute): Hono {
  const app = new Hono();
  app.route(path, route);
  return app;
}

const manualApp = makeApp(MANUAL_PATH, manualRoute);
const cronApp = makeApp(CRON_PATH, cronRoute);

function cronEnv(secret: string | null = CRON_SECRET): Bindings {
  return (secret === null ? {} : { CRON_SECRET: secret }) as Bindings;
}

function authorizedCronRequest(method: "GET" | "POST"): Request {
  return new Request(`http://internal${CRON_PATH}`, {
    method,
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockClear();
  requireUserOrApiKeyWithOrg.mockImplementation(async () => ({
    organization_id: ORGANIZATION_ID,
  }));
  executeAutoTopUpForOrganization.mockClear();
  executeAutoTopUpForOrganization.mockImplementation(async () => ({
    organizationId: ORGANIZATION_ID,
    success: false as const,
    status: "cutover_paused" as const,
    error:
      "Auto top-up charging is paused while the durable processor is rolled out",
  }));
  checkAndExecuteAutoTopUps.mockClear();
  checkAndExecuteAutoTopUps.mockImplementation(async () => ({
    timestamp: PAUSED_AT,
    cutoverPaused: true as const,
    controlMode: "paused" as const,
    organizationsChecked: 0 as const,
    organizationsProcessed: 0 as const,
    successful: 0 as const,
    failed: 0 as const,
    results: [] as [],
  }));
  logInfo.mockClear();
  logError.mockClear();
});

describe("manual auto-top-up cutover route", () => {
  test("uses STRICT fail-closed limiting and returns an explicit 503 paused state", async () => {
    expect(rateLimitConfigs).toHaveLength(1);
    expect(rateLimitConfigs[0]).toMatchObject({
      ...STRICT_RATE_LIMIT,
      failClosed: true,
    });

    const response = await manualApp.fetch(
      new Request(`http://internal${MANUAL_PATH}`, { method: "POST" }),
      {} as Bindings,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toMatchObject({
      success: false,
      status: "cutover_paused",
      code: "service_unavailable",
    });
    expect(executeAutoTopUpForOrganization).toHaveBeenCalledTimes(1);
    expect(executeAutoTopUpForOrganization).toHaveBeenCalledWith(
      ORGANIZATION_ID,
    );
  });

  test("requires organization authentication before calling the service", async () => {
    requireUserOrApiKeyWithOrg.mockImplementationOnce(async () => {
      throw AuthenticationError();
    });

    const response = await manualApp.fetch(
      new Request(`http://internal${MANUAL_PATH}`, { method: "POST" }),
      {} as Bindings,
    );

    expect(response.status).toBe(401);
    expect(executeAutoTopUpForOrganization).not.toHaveBeenCalled();
  });

  test("fails closed when the control-backed service is unavailable", async () => {
    executeAutoTopUpForOrganization.mockImplementationOnce(async () => {
      throw new Error("control row unavailable");
    });

    const response = await manualApp.fetch(
      new Request(`http://internal${MANUAL_PATH}`, { method: "POST" }),
      {} as Bindings,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ success: false, code: "internal_error" });
    expect(body).not.toHaveProperty("status", "cutover_paused");
  });
});

describe("scheduled auto-top-up cutover route", () => {
  test.each(["GET", "POST"] as const)(
    "accepts authenticated %s and reports paused zero work",
    async (method) => {
      const response = await cronApp.fetch(
        authorizedCronRequest(method),
        cronEnv(),
      );
      const body = (await response.json()) as {
        success: boolean;
        status: string;
        cutoverPaused: boolean;
        stats: Record<string, unknown>;
      };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        status: "cutover_paused",
        cutoverPaused: true,
        stats: {
          timestamp: PAUSED_AT.toISOString(),
          organizationsChecked: 0,
          organizationsProcessed: 0,
          successful: 0,
          failed: 0,
          details: [],
        },
      });
    },
  );

  test("requires a valid configured cron secret", async () => {
    const missingHeader = await cronApp.fetch(
      new Request(`http://internal${CRON_PATH}`, { method: "POST" }),
      cronEnv(),
    );
    const wrongHeader = await cronApp.fetch(
      new Request(`http://internal${CRON_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret" },
      }),
      cronEnv(),
    );
    const missingConfig = await cronApp.fetch(
      authorizedCronRequest("POST"),
      cronEnv(null),
    );

    expect(missingHeader.status).toBe(401);
    expect(wrongHeader.status).toBe(401);
    expect(missingConfig.status).toBe(403);
    expect(checkAndExecuteAutoTopUps).not.toHaveBeenCalled();
  });

  test("does not fabricate paused zero work when control lookup fails", async () => {
    checkAndExecuteAutoTopUps.mockImplementationOnce(async () => {
      throw new Error("control row unavailable");
    });

    const response = await cronApp.fetch(
      authorizedCronRequest("POST"),
      cronEnv(),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ success: false, code: "internal_error" });
    expect(body).not.toHaveProperty("stats");
  });
});
