/**
 * Session verification must separate "this credential is not valid" from
 * "the session-authority lookup failed". Before this test the second case was
 * indistinguishable from the first: any database or revocation-store failure
 * escaped verifySessionToken as `null`, so every caller answered
 * 401 "Invalid or expired session token" during an outage.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const lookupError = new Error("connect ECONNREFUSED 127.0.0.1:5432");

/** Only the session-authority lookup fails; everything else in the db module is real. */
vi.mock("../src/server/db/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/server/db/index.ts")>();
  return {
    ...actual,
    getDb: () => ({
      execute: async () => {
        throw lookupError;
      },
    }),
  };
});

process.env.NODE_ENV = "test";
process.env.STEWARD_JWT_SECRET = "session-authority-test-secret-0123456789";

let verifySessionToken: typeof import("../src/server/api/services/context.ts").verifySessionToken;
let signAccessToken: typeof import("../src/server/auth/jwt.ts").signAccessToken;
let revocationStore: typeof import("../src/server/auth/revocation.ts").revocationStore;
let TokenRevokedError: typeof import("../src/server/auth/revocation.ts").TokenRevokedError;

beforeAll(async () => {
  ({ verifySessionToken } = await import(
    "../src/server/api/services/context.ts"
  ));
  ({ signAccessToken } = await import("../src/server/auth/jwt.ts"));
  ({ revocationStore, TokenRevokedError } = await import(
    "../src/server/auth/revocation.ts"
  ));
});

describe("verifySessionToken", () => {
  it("rejects when the session-authority lookup fails instead of reporting no session", async () => {
    const token = await signAccessToken({
      address: "0x0000000000000000000000000000000000000001",
      tenantId: "tenant-1",
      userId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(verifySessionToken(token)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("still rejects a revoked token as no session", async () => {
    const token = await signAccessToken({
      address: "0x0000000000000000000000000000000000000001",
      tenantId: "tenant-1",
      userId: "11111111-1111-4111-8111-111111111111",
    });
    const original = revocationStore.isRevoked;
    revocationStore.isRevoked = async () => {
      throw new TokenRevokedError();
    };
    try {
      await expect(verifySessionToken(token)).resolves.toBeNull();
    } finally {
      revocationStore.isRevoked = original;
    }
  });

  it("still rejects an unverifiable token as no session", async () => {
    await expect(verifySessionToken("not-a-jwt")).resolves.toBeNull();
  });
});
