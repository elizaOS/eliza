/** Verifies cron authentication and redacted telemetry-cleanup metrics at the HTTP boundary. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const cleanupLifecycle = mock(async () => ({
  scanned: 7,
  closed: 3,
  retained: 3,
  deleted: 2,
}));
const info = mock(() => undefined);

mock.module("@/lib/services/user-sessions", () => ({
  userSessionsService: { cleanupLifecycle },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info,
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

function call(secret?: string) {
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }),
    { CRON_SECRET: "cron-secret" },
  );
}

describe("cleanup-user-sessions cron route", () => {
  beforeEach(() => {
    cleanupLifecycle.mockClear();
    info.mockClear();
  });

  test("rejects unauthenticated calls before touching telemetry", async () => {
    const response = await call();
    expect(response.status).toBe(401);
    expect(cleanupLifecycle).not.toHaveBeenCalled();
  });

  test("returns and logs aggregate lifecycle metrics without row data", async () => {
    const response = await call("cron-secret");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      scanned: 7,
      closed: 3,
      retained: 3,
      deleted: 2,
    });
    expect(cleanupLifecycle).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "[UserSessionTelemetry] Lifecycle cleanup completed",
      expect.objectContaining({
        scanned: 7,
        closed: 3,
        retained: 3,
        deleted: 2,
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("session_token");
  });
});
