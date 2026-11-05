/**
 * Session verification must separate "this credential is not valid" from
 * "the session authority could not be read". Before this test both cases
 * resolved `null`, so a database outage was answered as `401 Invalid or
 * expired session token` and every caller logged the user out.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

const environment = {
  NODE_ENV: "test",
  STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
  STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
  STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
  STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
};
const previous = new Map<string, string | undefined>();

let verifySessionToken: typeof import("../api/services/context.ts").verifySessionToken;
let signAccessToken: typeof import("../auth/jwt.ts").signAccessToken;
let withTenantTransactionDatabase: typeof import("../db/client.ts").withTenantTransactionDatabase;

beforeAll(async () => {
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  ({ verifySessionToken } = await import("../api/services/context.ts"));
  ({ signAccessToken } = await import("../auth/jwt.ts"));
  ({ withTenantTransactionDatabase } = await import("../db/client.ts"));
});

afterAll(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("verifySessionToken", () => {
  test("propagates a failed session-authority lookup instead of reporting a bad token", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const token = await signAccessToken({
      address: "0x0000000000000000000000000000000000000001",
      tenantId,
      userId,
    });

    const failure = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    // Only the authority lookup fails; the credential itself verifies.
    const brokenDb = {
      execute: async () => {
        throw failure;
      },
    };

    const outcome = await withTenantTransactionDatabase(
      brokenDb as never,
      { tenantId, userId },
      async () => {
        try {
          return { resolved: await verifySessionToken(token) };
        } catch (error) {
          return { rejected: error };
        }
      },
    );

    // Before the fix this resolved `{ resolved: null }`, which every caller
    // turns into 401 "Invalid or expired session token".
    expect(outcome).toEqual({ rejected: failure });
  });

  test("still reports a revoked token as no session", async () => {
    const { revocationStore, TokenRevokedError } = await import(
      "../auth/revocation.ts"
    );
    const token = await signAccessToken({
      address: "0x0000000000000000000000000000000000000001",
      tenantId: randomUUID(),
      userId: randomUUID(),
    });

    const original = revocationStore.isRevoked;
    revocationStore.isRevoked = async () => {
      throw new TokenRevokedError();
    };
    try {
      // A revoked `jti` is a credential verdict, not an outage.
      expect(await verifySessionToken(token)).toBeNull();
    } finally {
      revocationStore.isRevoked = original;
    }
  });

  test("still reports an unverifiable or expired token as no session", async () => {
    expect(await verifySessionToken("not-a-jwt")).toBeNull();

    const expired = await signAccessToken(
      {
        address: "0x0000000000000000000000000000000000000001",
        tenantId: randomUUID(),
        userId: randomUUID(),
      },
      "-1s",
    );
    expect(await verifySessionToken(expired)).toBeNull();
  });
});
