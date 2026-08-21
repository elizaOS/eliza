/**
 * Drives the real Cloudflare cron fanout into the mobile-grant cleanup route,
 * proving the scheduled POST reaches the sweeper and requires the cron secret.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { Bindings } from "@/types/cloud-worker-env";

const cleanupExpiredMobileAppAuthGrants = mock(async () => ({
  grantsDeleted: 2,
  grantsScanned: 2,
  inactiveCredentialsTombstoned: 1,
  acknowledgedCredentialsTombstoned: 1,
  integrityViolations: 0,
  batchesProcessed: 1,
  batchSize: 250,
  maxBatches: 8,
  scanCapacity: 2000,
  remainingExpiredGrants: 0,
  remainingWork: false,
}));
const loggerError = mock(() => undefined);
const mobileAppAuthActual = await import("@/lib/services/mobile-app-auth");

mock.module("@/lib/services/mobile-app-auth", () => ({
  ...mobileAppAuthActual,
  cleanupExpiredMobileAppAuthGrants,
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: loggerError,
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { CRON_FANOUT, makeCronHandler } = await import(
  "@/lib/cron/cloudflare-cron"
);
const cleanupRoute = (await import("../cron/cleanup-mobile-app-auth/route"))
  .default;

const PATH = "/api/cron/cleanup-mobile-app-auth";
const SCHEDULE = "*/15 * * * *";
const CRON_SECRET = "mobile-cleanup-secret";

function makeEnv(): Bindings {
  return { CRON_SECRET } as Bindings;
}

async function fireScheduled(): Promise<void> {
  const app = new Hono();
  app.route(PATH, cleanupRoute);
  const scheduled = makeCronHandler((request, env, context) =>
    app.fetch(request, env, context),
  );
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => undefined,
  };
  await scheduled(
    { cron: SCHEDULE, scheduledTime: Date.now() },
    makeEnv(),
    context as never,
  );
  await Promise.all(pending);
}

beforeEach(() => {
  cleanupExpiredMobileAppAuthGrants.mockClear();
  loggerError.mockClear();
});

describe("mobile App Auth cleanup cron", () => {
  test("is registered on the fifteen-minute schedule and reaches the service", async () => {
    expect(CRON_FANOUT[SCHEDULE]).toContain(PATH);
    expect(CRON_FANOUT["0 */6 * * *"]).not.toContain(PATH);
    await fireScheduled();
    expect(cleanupExpiredMobileAppAuthGrants).toHaveBeenCalledTimes(1);
  });

  test("rejects a direct POST without the cron secret", async () => {
    const app = new Hono();
    app.route(PATH, cleanupRoute);
    const response = await app.fetch(
      new Request(`http://internal${PATH}`, { method: "POST" }),
      makeEnv(),
    );
    expect(response.status).toBe(401);
    expect(cleanupExpiredMobileAppAuthGrants).not.toHaveBeenCalled();
  });

  test("reports reference corruption while poisoned rows remain durable", async () => {
    cleanupExpiredMobileAppAuthGrants.mockResolvedValueOnce({
      grantsDeleted: 2,
      grantsScanned: 3,
      inactiveCredentialsTombstoned: 1,
      acknowledgedCredentialsTombstoned: 1,
      integrityViolations: 1,
      batchesProcessed: 1,
      batchSize: 250,
      maxBatches: 8,
      scanCapacity: 2000,
      remainingExpiredGrants: 1,
      remainingWork: true,
    });
    const app = new Hono();
    app.route(PATH, cleanupRoute);
    const response = await app.fetch(
      new Request(`http://internal${PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      makeEnv(),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "An unexpected error occurred",
      code: "internal_error",
    });
    expect(loggerError).toHaveBeenCalledWith(
      "[MobileAppAuth] Expired grant cleanup failed",
      expect.objectContaining({
        error: expect.objectContaining({
          code: "MOBILE_APP_AUTH_CLEANUP_INTEGRITY_VIOLATION",
          context: expect.objectContaining({
            integrityViolations: 1,
            grantsScanned: 3,
            remainingExpiredGrants: 1,
            remainingWork: true,
          }),
        }),
      }),
    );
  });
});
