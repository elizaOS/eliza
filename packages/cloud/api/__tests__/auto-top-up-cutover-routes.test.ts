/**
 * Exercises the real manual and cron auto-top-up Hono routes against a
 * deterministic durable-service seam without opening a database or Stripe.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

class TestBoundaryError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "authentication_required" | "permission_denied",
    message: string,
  ) {
    super(message);
  }
}

function AuthenticationError(message = "Authentication required") {
  return new TestBoundaryError(401, "authentication_required", message);
}

function ForbiddenError(message = "Forbidden") {
  return new TestBoundaryError(403, "permission_denied", message);
}

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_context: unknown, error: unknown) => {
    const boundaryError =
      error instanceof TestBoundaryError ? error : undefined;
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
        code: boundaryError?.code ?? "internal_error",
      },
      { status: boundaryError?.status ?? 500 },
    );
  },
}));

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000207";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000002717";
const MANUAL_PATH = "/api/auto-top-up/trigger";
const CRON_PATH = "/api/cron/auto-top-up";
const CRON_SECRET = "auto-top-up-durable-test-secret";
const STARTED_AT = new Date("2026-08-17T12:00:00.000Z");

type ResultStatus =
  | "claimed"
  | "payment_pending"
  | "payment_succeeded"
  | "credited"
  | "canceled"
  | "manual_review"
  | "not_needed"
  | "unavailable";

interface DurableResult {
  organizationId: string;
  success: boolean;
  amount?: number;
  previousBalance?: number;
  newBalance?: number;
  message?: string;
  error?: string;
  attemptId?: string;
  status: ResultStatus;
  recovered: boolean;
}

interface DurableSweepResult {
  timestamp: Date;
  rolloutPaused: boolean;
  cutoverPaused: boolean;
  controlMode: "paused" | "durable";
  organizationsChecked: number;
  organizationsProcessed: number;
  successful: number;
  failed: number;
  recovered: number;
  claimed: number;
  skipped: number;
  results: DurableResult[];
}

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
  moneyRateLimit: (config: Record<string, unknown>) => {
    rateLimitConfigs.push({
      ...config,
      failClosed: true,
      localLease: false,
    });
    return async (_context: unknown, next: () => Promise<void>) => next();
  },
}));

const executeAutoTopUpForOrganization = mock(
  async (
    _organizationId: string,
    _options: { source: "manual" },
  ): Promise<DurableResult> => ({
    organizationId: ORGANIZATION_ID,
    success: true,
    amount: 25,
    previousBalance: 4,
    newBalance: 29,
    attemptId: ATTEMPT_ID,
    status: "credited",
    recovered: false,
  }),
);
const checkAndExecuteAutoTopUps = mock(
  async (_options: {
    source: "cron";
    limit: number;
  }): Promise<DurableSweepResult> => ({
    timestamp: STARTED_AT,
    rolloutPaused: false,
    cutoverPaused: false,
    controlMode: "durable",
    organizationsChecked: 2,
    organizationsProcessed: 1,
    successful: 1,
    failed: 0,
    recovered: 1,
    claimed: 0,
    skipped: 1,
    results: [
      {
        organizationId: ORGANIZATION_ID,
        success: true,
        amount: 25,
        previousBalance: 4,
        newBalance: 29,
        attemptId: ATTEMPT_ID,
        status: "credited",
        recovered: true,
      },
      {
        organizationId: "org-skipped",
        success: false,
        status: "not_needed",
        recovered: false,
      },
    ],
  }),
);

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

function cronEnv(secret: string | null = CRON_SECRET) {
  return secret === null ? {} : { CRON_SECRET: secret };
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
    success: true,
    amount: 25,
    previousBalance: 4,
    newBalance: 29,
    attemptId: ATTEMPT_ID,
    status: "credited",
    recovered: false,
  }));
  checkAndExecuteAutoTopUps.mockClear();
  checkAndExecuteAutoTopUps.mockImplementation(async () => ({
    timestamp: STARTED_AT,
    rolloutPaused: false,
    cutoverPaused: false,
    controlMode: "durable",
    organizationsChecked: 2,
    organizationsProcessed: 1,
    successful: 1,
    failed: 0,
    recovered: 1,
    claimed: 0,
    skipped: 1,
    results: [
      {
        organizationId: ORGANIZATION_ID,
        success: true,
        amount: 25,
        previousBalance: 4,
        newBalance: 29,
        attemptId: ATTEMPT_ID,
        status: "credited",
        recovered: true,
      },
      {
        organizationId: "org-skipped",
        success: false,
        status: "not_needed",
        recovered: false,
      },
    ],
  }));
  logInfo.mockClear();
  logError.mockClear();
});

describe("manual durable auto-top-up route", () => {
  test("uses STRICT fail-closed MONEY limiting", () => {
    expect(rateLimitConfigs).toHaveLength(1);
    expect(rateLimitConfigs[0]).toMatchObject({
      ...STRICT_RATE_LIMIT,
      failClosed: true,
      localLease: false,
    });
  });

  test("dispatches only the authenticated organization to the manual source", async () => {
    const response = await manualApp.fetch(
      new Request(`http://internal${MANUAL_PATH}`, { method: "POST" }),
      {},
    );

    expect(response.status).toBe(200);
    expect(executeAutoTopUpForOrganization).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      {
        source: "manual",
      },
    );
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: "Auto top-up successful! Added $25.00",
      amount: 25,
      previousBalance: 4,
      newBalance: 29,
      attemptId: ATTEMPT_ID,
      status: "credited",
      recovered: false,
    });
  });

  test("returns a stable no-op when no new charge is needed", async () => {
    executeAutoTopUpForOrganization.mockImplementationOnce(async () => ({
      organizationId: ORGANIZATION_ID,
      success: false,
      status: "not_needed",
      recovered: false,
    }));

    const response = await manualApp.fetch(
      new Request(`http://internal${MANUAL_PATH}`, { method: "POST" }),
      {},
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      status: "not_needed",
      message: "Balance is above threshold. Auto top-up not needed.",
    });
  });

  test("returns 202 while a durable attempt is converging", async () => {
    executeAutoTopUpForOrganization.mockImplementationOnce(async () => ({
      organizationId: ORGANIZATION_ID,
      success: false,
      attemptId: ATTEMPT_ID,
      status: "payment_succeeded",
      recovered: true,
    }));

    const response = await manualApp.fetch(
      new Request(`http://internal${MANUAL_PATH}`, { method: "POST" }),
      {},
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "payment_succeeded",
      attemptId: ATTEMPT_ID,
      recovered: true,
    });
  });

  test("returns a retryable 503 while new claims are paused", async () => {
    executeAutoTopUpForOrganization.mockImplementationOnce(async () => ({
      organizationId: ORGANIZATION_ID,
      success: false,
      error: "Durable auto top-up activation is paused",
      status: "unavailable",
      recovered: false,
    }));

    const response = await manualApp.fetch(
      new Request(`http://internal${MANUAL_PATH}`, { method: "POST" }),
      {},
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      status: "unavailable",
      code: "service_unavailable",
    });
  });

  test("returns 409 for an attempt requiring operator reconciliation", async () => {
    executeAutoTopUpForOrganization.mockImplementationOnce(async () => ({
      organizationId: ORGANIZATION_ID,
      success: false,
      error: "Settlement could not be proven",
      attemptId: ATTEMPT_ID,
      status: "manual_review",
      recovered: true,
    }));

    const response = await manualApp.fetch(
      new Request(`http://internal${MANUAL_PATH}`, { method: "POST" }),
      {},
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Settlement could not be proven",
      code: "billing_state_conflict",
      status: "manual_review",
    });
  });

  test("returns 400 after a durable attempt is canceled", async () => {
    executeAutoTopUpForOrganization.mockImplementationOnce(async () => ({
      organizationId: ORGANIZATION_ID,
      success: false,
      error: "Payment requires a new payment method",
      attemptId: ATTEMPT_ID,
      status: "canceled",
      recovered: false,
    }));

    const response = await manualApp.fetch(
      new Request(`http://internal${MANUAL_PATH}`, { method: "POST" }),
      {},
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Payment requires a new payment method",
      status: "canceled",
    });
  });

  test("requires organization authentication before dispatch", async () => {
    requireUserOrApiKeyWithOrg.mockImplementationOnce(async () => {
      throw AuthenticationError();
    });

    const response = await manualApp.fetch(
      new Request(`http://internal${MANUAL_PATH}`, { method: "POST" }),
      {},
    );

    expect(response.status).toBe(401);
    expect(executeAutoTopUpForOrganization).not.toHaveBeenCalled();
  });

  test("surfaces an unavailable repository through the shared boundary", async () => {
    executeAutoTopUpForOrganization.mockImplementationOnce(async () => {
      throw new Error("attempt repository unavailable");
    });

    const response = await manualApp.fetch(
      new Request(`http://internal${MANUAL_PATH}`, { method: "POST" }),
      {},
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "internal_error",
    });
  });
});

describe("scheduled durable auto-top-up route", () => {
  test.each(["GET", "POST"] as const)(
    "runs an authenticated bounded %s sweep and reports durable outcomes",
    async (method) => {
      const response = await cronApp.fetch(
        authorizedCronRequest(method),
        cronEnv(),
      );
      const body = (await response.json()) as {
        stats: Record<string, unknown> & { details: unknown[] };
      };

      expect(response.status).toBe(200);
      expect(checkAndExecuteAutoTopUps).toHaveBeenCalledWith({
        source: "cron",
        limit: 100,
      });
      expect(body.stats).toMatchObject({
        timestamp: STARTED_AT.toISOString(),
        organizationsChecked: 2,
        organizationsProcessed: 1,
        successful: 1,
        failed: 0,
        limit: 100,
        recovered: 1,
        claimed: 0,
        skipped: 1,
        rolloutPaused: false,
        cutoverPaused: false,
        controlMode: "durable",
      });
      expect(body.stats.details).toEqual([
        {
          organizationId: ORGANIZATION_ID,
          success: true,
          amount: 25,
          previousBalance: 4,
          newBalance: 29,
          attemptId: ATTEMPT_ID,
          status: "credited",
          recovered: true,
        },
        {
          organizationId: "org-skipped",
          success: false,
          status: "not_needed",
          recovered: false,
        },
      ]);
    },
  );

  test("reports a closed rollout without treating recovery as a cron failure", async () => {
    checkAndExecuteAutoTopUps.mockImplementationOnce(async () => ({
      timestamp: STARTED_AT,
      rolloutPaused: true,
      cutoverPaused: true,
      controlMode: "paused",
      organizationsChecked: 1,
      organizationsProcessed: 1,
      successful: 1,
      failed: 0,
      recovered: 1,
      claimed: 0,
      skipped: 0,
      results: [
        {
          organizationId: ORGANIZATION_ID,
          success: true,
          attemptId: ATTEMPT_ID,
          status: "credited",
          recovered: true,
        },
      ],
    }));

    const response = await cronApp.fetch(
      authorizedCronRequest("POST"),
      cronEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      cutoverPaused: true,
      controlMode: "paused",
      stats: {
        rolloutPaused: true,
        cutoverPaused: true,
        controlMode: "paused",
        organizationsChecked: 1,
        recovered: 1,
        claimed: 0,
      },
    });
  });

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

  test("does not fabricate sweep results when the repository is unavailable", async () => {
    checkAndExecuteAutoTopUps.mockImplementationOnce(async () => {
      throw new Error("attempt repository unavailable");
    });

    const response = await cronApp.fetch(
      authorizedCronRequest("POST"),
      cronEnv(),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "internal_error",
    });
  });
});
