/**
 * POST /api/auth/steward-session availability scoping during an SSO
 * logout-marker STORE outage, through the real route module with the marker
 * service mocked to throw (what the repository read does when Postgres is
 * unreachable). Bridge-issued tokens (`bridged` claim, stamped by the
 * sso-bridge exchange re-mint) must fail CLOSED with the bridge legs' 503
 * `sso_unavailable` and plant no cookies; ordinary tokens must never touch
 * the marker store at all and keep minting — the pre-bridge no-datastore
 * availability posture the Redis-outage suite pins.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const emitAudit = mock(async () => undefined);
const verifyStewardTokenCached = mock(async (_env: unknown, token: string) => {
  const base = {
    userId: "steward-user-1",
    email: "person@example.test",
    expiration: Math.floor(Date.now() / 1000) + 900,
    issuedAt: Math.floor(Date.now() / 1000) - 60,
  };
  if (token === "bridged-token") return { ...base, bridged: true };
  if (token === "plain-token") return base;
  return null;
});
const syncUserFromSteward = mock(async () => ({
  id: "cloud-user-1",
  organization_id: "org-1",
  initialCreditsGranted: false,
  initialFreeCreditsUsd: "0.00",
  welcomeBonusWithheld: false,
  welcomeBonusWithheldReason: undefined,
  welcomeBonusWithheldMessage: undefined,
}));
const isBlockedBySsoBridgeLogout = mock(async () => {
  throw new Error("connect ECONNREFUSED: postgres down");
});

mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ emit: emitAudit }),
}));

mock.module("@/lib/auth/steward-client", () => ({
  verifyStewardTokenCached,
}));

mock.module("@/lib/steward-sync", () => ({
  describeSyncError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  syncUserFromSteward,
}));

mock.module("@/lib/services/sso-bridge-codes", () => ({
  isBlockedBySsoBridgeLogout,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: stewardSessionRoute } = await import(
  "../auth/steward-session/route"
);

const ENV = {
  ENVIRONMENT: "staging",
  NODE_ENV: "production",
  STEWARD_SESSION_SECRET: "test-secret",
};

let ipCounter = 0;

function postStewardSession(body: unknown) {
  ipCounter += 1;
  const app = new Hono();
  app.route("/api/auth/steward-session", stewardSessionRoute);
  return app.fetch(
    new Request("https://api-staging.elizacloud.ai/api/auth/steward-session", {
      method: "POST",
      headers: {
        "cf-connecting-ip": `203.0.113.${ipCounter}`,
        "content-type": "application/json",
        origin: "https://staging.elizacloud.ai",
      },
      body: JSON.stringify(body),
    }),
    ENV,
  );
}

beforeEach(() => {
  emitAudit.mockClear();
  verifyStewardTokenCached.mockClear();
  syncUserFromSteward.mockClear();
  isBlockedBySsoBridgeLogout.mockClear();
});

describe("POST /api/auth/steward-session — logout-marker store outage", () => {
  test("a BRIDGE-issued token fails closed: 503 sso_unavailable, no cookies", async () => {
    const res = await postStewardSession({ token: "bridged-token" });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: "sso_unavailable",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(isBlockedBySsoBridgeLogout).toHaveBeenCalledTimes(1);
    expect(syncUserFromSteward).not.toHaveBeenCalled();
  });

  test("an ORDINARY token never touches the marker store and still mints", async () => {
    const res = await postStewardSession({ token: "plain-token" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      userId: "cloud-user-1",
      stewardUserId: "steward-user-1",
    });
    expect(res.headers.get("set-cookie") ?? "").toContain(
      "steward-token-staging=plain-token",
    );
    expect(isBlockedBySsoBridgeLogout).not.toHaveBeenCalled();
  });
});
