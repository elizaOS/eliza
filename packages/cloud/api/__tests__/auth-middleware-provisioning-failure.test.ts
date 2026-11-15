/**
 * The global auth middleware answers for every protected `/api/` route before
 * a route handler runs. These requests go through the real middleware and the
 * real session resolution on a path outside the public list; only the Steward
 * token verification, the user lookup and the provisioning sync are stubbed.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

process.env.MOCK_REDIS = "1";

const stewardClient = await import(
  "@elizaos/cloud-shared/lib/auth/steward-client"
);
const { usersService } = await import(
  "@elizaos/cloud-shared/lib/services/users"
);
const stewardSync = await import("@elizaos/cloud-shared/lib/steward-sync");
const { authMiddleware } = await import("../src/middleware/auth");

const PROTECTED_PATH = "/api/v1/user";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function app() {
  const hono = new Hono<AppEnv>();
  hono.use("*", authMiddleware);
  hono.get(PROTECTED_PATH, (c) => c.json({ reached: true }));
  return hono;
}

async function firstRequest(syncOutcome: { reject: unknown } | "no-session") {
  if (syncOutcome === "no-session") {
    spies.push(
      spyOn(stewardClient, "verifyStewardTokenCached").mockResolvedValue(null),
    );
  } else {
    spies.push(
      spyOn(stewardClient, "verifyStewardTokenCached").mockResolvedValue({
        userId: "steward-new",
        issuedAt: 1,
        expiration: 2,
      }),
      spyOn(usersService, "getByStewardId").mockResolvedValue(undefined),
      spyOn(stewardSync, "syncUserFromSteward").mockRejectedValue(
        syncOutcome.reject,
      ),
    );
  }
  const response = await app().request(
    `https://fixture.example.test${PROTECTED_PATH}`,
    { headers: { authorization: "Bearer aaa.bbb.ccc" } },
    { NODE_ENV: "test", ENVIRONMENT: "production" } as never,
  );
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    body: (await response.json()) as Record<string, unknown>,
  };
}

test("a provisioning outage on a protected route is a retryable 503, not a revoked session", async () => {
  for (const outage of [
    Object.assign(new Error("connection failure"), { code: "08006" }),
    Object.assign(new Error("terminating connection"), { code: "57P01" }),
  ]) {
    const answer = await firstRequest({ reject: outage });
    expect(answer.status).toBe(503);
    expect(answer.retryAfter).toBe("5");
    expect(answer.body).toMatchObject({
      success: false,
      code: "account_not_ready",
      retryAfterSeconds: 5,
    });
    for (const spy of spies.splice(0)) spy.mockRestore();
  }
});

test("an identity conflict on a protected route is a 409", async () => {
  const answer = await firstRequest({
    reject: new stewardSync.StewardPhoneAccountConflictError(
      "verified_phone_unique_conflict",
    ),
  });
  expect(answer.status).toBe(409);
  expect(answer.retryAfter).toBeNull();
  expect(answer.body).toMatchObject({
    success: false,
    code: "identity_conflict",
  });
});

test("any other provisioning failure, and a missing session, stay 401", async () => {
  const unknown = await firstRequest({
    reject: Object.assign(new Error("duplicate key"), { code: "23505" }),
  });
  expect(unknown.status).toBe(401);
  expect(unknown.body).toMatchObject({ code: "authentication_required" });
  for (const spy of spies.splice(0)) spy.mockRestore();

  const anonymous = await firstRequest("no-session");
  expect(anonymous.status).toBe(401);
  expect(anonymous.body).toMatchObject({ code: "authentication_required" });
});
