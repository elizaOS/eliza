/**
 * Voice-session JWT: mint/verify/expiry/revocation/claim-mismatch.
 *
 * Signing keys are generated fresh per run (ES256) and injected via the same
 * env vars `auth/jwks` reads, so the REAL sign/verify path is exercised — no
 * mock of jose, no stub of the verifier under test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

import {
  __resetVoiceSessionRevocationClientForTests,
  __setVoiceSessionRevocationStoreForTests,
  isVoiceSessionJwtConfigured,
  mintVoiceSessionToken,
  revokeVoiceSessionToken,
  VoiceSessionTokenError,
  verifyVoiceSessionToken,
} from "../jwt";

/** Minimal in-memory Redis-shaped store for the revocation contract. */
function makeFakeRedis() {
  const map = new Map<string, string>();
  return {
    store: map,
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async set(key: string, value: unknown) {
      map.set(key, String(value));
      return "OK";
    },
    async getdel(key: string) {
      const v = map.get(key) ?? null;
      map.delete(key);
      return v;
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (map.delete(k)) n++;
      return n;
    },
  };
}

const CLAIMS = {
  sessionId: "sess-1",
  organizationId: "org-1",
  userId: "user-1",
  agentId: "agent-1",
  conversationId: "conv-1",
};

const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  savedEnv.JWT_SIGNING_PRIVATE_KEY = process.env.JWT_SIGNING_PRIVATE_KEY;
  savedEnv.JWT_SIGNING_PUBLIC_KEY = process.env.JWT_SIGNING_PUBLIC_KEY;
  savedEnv.JWT_SIGNING_KEY_ID = process.env.JWT_SIGNING_KEY_ID;
  process.env.JWT_SIGNING_PRIVATE_KEY = Buffer.from(await exportPKCS8(privateKey)).toString(
    "base64",
  );
  process.env.JWT_SIGNING_PUBLIC_KEY = Buffer.from(await exportSPKI(publicKey)).toString("base64");
  process.env.JWT_SIGNING_KEY_ID = "test-voice-key";
  __resetVoiceSessionRevocationClientForTests();
});

beforeEach(() => {
  __resetVoiceSessionRevocationClientForTests();
  __setVoiceSessionRevocationStoreForTests(makeFakeRedis() as never);
});

afterAll(() => {
  __setVoiceSessionRevocationStoreForTests(null);
  __resetVoiceSessionRevocationClientForTests();
  process.env.JWT_SIGNING_PRIVATE_KEY = savedEnv.JWT_SIGNING_PRIVATE_KEY;
  process.env.JWT_SIGNING_PUBLIC_KEY = savedEnv.JWT_SIGNING_PUBLIC_KEY;
  process.env.JWT_SIGNING_KEY_ID = savedEnv.JWT_SIGNING_KEY_ID;
});

describe("voice-session jwt", () => {
  test("is configured once signing keys are present", () => {
    expect(isVoiceSessionJwtConfigured()).toBe(true);
  });

  test("mint + verify round-trips the scoped claims", async () => {
    const minted = await mintVoiceSessionToken(CLAIMS);
    const verified = await verifyVoiceSessionToken(minted.token, {
      sessionId: CLAIMS.sessionId,
    });
    expect(verified.claims).toEqual(CLAIMS);
    expect(verified.jti).toBe(minted.jti);
  });

  test("clamps TTL to the <=120s ceiling", async () => {
    const now = () => 1_000_000_000_000;
    const minted = await mintVoiceSessionToken({ ...CLAIMS, ttlSeconds: 9999, now });
    // exp - iat must be <=120.
    expect(minted.expSeconds - Math.floor(now() / 1000)).toBeLessThanOrEqual(120);
  });

  test("rejects an expired token", async () => {
    const mintAt = 1_000_000_000_000;
    const minted = await mintVoiceSessionToken({ ...CLAIMS, ttlSeconds: 30, now: () => mintAt });
    const wellPastExp = mintAt + 200_000; // +200s, past the 30s TTL + skew.
    await expect(
      verifyVoiceSessionToken(minted.token, undefined, { now: () => wellPastExp }),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  test("rejects a claim mismatch (sessionId)", async () => {
    const minted = await mintVoiceSessionToken(CLAIMS);
    await expect(
      verifyVoiceSessionToken(minted.token, { sessionId: "different-session" }),
    ).rejects.toBeInstanceOf(VoiceSessionTokenError);
    await expect(
      verifyVoiceSessionToken(minted.token, { sessionId: "different-session" }),
    ).rejects.toMatchObject({ code: "claim_mismatch" });
  });

  test("rejects an org claim mismatch", async () => {
    const minted = await mintVoiceSessionToken(CLAIMS);
    await expect(
      verifyVoiceSessionToken(minted.token, { organizationId: "other-org" }),
    ).rejects.toMatchObject({ code: "claim_mismatch" });
  });

  test("rejects a malformed token", async () => {
    await expect(verifyVoiceSessionToken("not-a-jwt")).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  test("revocation with a durable store makes verify reject as revoked", async () => {
    const fake = makeFakeRedis();
    __setVoiceSessionRevocationStoreForTests(fake as never);
    try {
      const minted = await mintVoiceSessionToken(CLAIMS);
      // Pre-revoke: verify passes.
      const ok = await verifyVoiceSessionToken(minted.token, { sessionId: CLAIMS.sessionId });
      expect(ok.jti).toBe(minted.jti);
      // Revoke, then verify must reject as revoked (fail-closed on presence).
      await revokeVoiceSessionToken(minted.jti, minted.expSeconds);
      await expect(
        verifyVoiceSessionToken(minted.token, { sessionId: CLAIMS.sessionId }),
      ).rejects.toMatchObject({ code: "revoked" });
    } finally {
      __setVoiceSessionRevocationStoreForTests(null);
    }
  });

  test("revocation check is fail-closed when the store errors", async () => {
    const erroring = {
      async get() {
        throw new Error("redis down");
      },
      async set() {
        return "OK";
      },
      async getdel() {
        return null;
      },
      async del() {
        return 0;
      },
    };
    __setVoiceSessionRevocationStoreForTests(erroring as never);
    try {
      const minted = await mintVoiceSessionToken(CLAIMS);
      await expect(
        verifyVoiceSessionToken(minted.token, { sessionId: CLAIMS.sessionId }),
      ).rejects.toMatchObject({ code: "revoked" });
    } finally {
      __setVoiceSessionRevocationStoreForTests(null);
    }
  });
});
