import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { scryptSync } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";

import { getJwtSecret, signAccessToken, verifyToken } from "../jwt";
import { SessionManager } from "../session";

const ENV_KEYS = [
  "STEWARD_JWT_SECRET",
  "STEWARD_SESSION_SECRET",
  "STEWARD_MASTER_PASSWORD",
  "STEWARD_DB_MODE",
  "STEWARD_EMBEDDED",
  "STEWARD_EMBEDDED_MODE",
  "DATABASE_URL",
  "STEWARD_ALLOW_DEV_SECRETS",
  "NODE_ENV",
] as const;

describe("getJwtSecret embedded-mode master password fallback (SEC-013)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.STEWARD_DB_MODE = "pglite";
    process.env.STEWARD_MASTER_PASSWORD = "embedded-master-password-for-tests";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it("never uses the raw master password as the JWT secret", () => {
    const secret = getJwtSecret({ warn: null });
    expect(secret).not.toBe(process.env.STEWARD_MASTER_PASSWORD);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it("derives the JWT secret via domain-separated scrypt", () => {
    const expected = (
      scryptSync(
        "embedded-master-password-for-tests",
        "steward-kdf:jwt-signing:v1",
        32,
      ) as Buffer
    ).toString("hex");
    expect(getJwtSecret({ warn: null })).toBe(expected);
  });

  it("signs and verifies tokens with the derived secret", async () => {
    const token = await signAccessToken({
      address: "0x0000000000000000000000000000000000000000",
      tenantId: "default",
      userId: "user_123",
      sub: "caller-controlled",
    });
    const payload = await verifyToken(token);
    expect(payload.tenantId).toBe("default");
    expect(payload.userId).toBe("user_123");
    expect(payload.sub).toBe("user_123");
    expect(decodeProtectedHeader(token)).toEqual({ alg: "HS256", typ: "JWT" });
  });

  it("prefers an explicit STEWARD_JWT_SECRET over the derivation", () => {
    process.env.STEWARD_JWT_SECRET = "explicit-jwt-secret-with-32-characters!!";
    expect(getJwtSecret({ warn: null })).toBe(
      "explicit-jwt-secret-with-32-characters!!",
    );
  });
});

describe("session identity claims", () => {
  it("binds the standard subject claim to the authenticated user", async () => {
    const session = new SessionManager({
      secret: "test-secret-at-least-32-characters",
    });
    const token = await session.createSession("user_123", {
      sub: "caller-controlled",
      userId: "caller-controlled",
      jti: "caller-controlled",
    });

    expect(decodeJwt(token)).toMatchObject({
      sub: "user_123",
      userId: "user_123",
    });
    expect(decodeJwt(token).jti).not.toBe("caller-controlled");
  });
});

describe("JWT secret strength policy (SEC-053, SEC-054)", () => {
  it("hard-fails short configured secrets in production regardless of source", async () => {
    const { checkJwtSecretStrength } = await import("../jwt");
    expect(() =>
      checkJwtSecretStrength("abc123", "STEWARD_JWT_SECRET", {
        nodeEnv: "production",
      }),
    ).toThrow("must be at least 32 characters in production");
  });

  it("warns (does not throw) on short configured secrets outside production", async () => {
    // Fresh module instance so the warn-once flag starts clean.
    const { checkJwtSecretStrength } = await import(
      `../jwt?sec053=${Date.now()}`
    );
    const warnings: string[] = [];
    checkJwtSecretStrength("abc123", "STEWARD_JWT_SECRET", {
      nodeEnv: "staging",
      warn: (m) => warnings.push(m),
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("shorter than 32 characters");
  });

  it("accepts 32+ character secrets silently", async () => {
    const { checkJwtSecretStrength } = await import(
      `../jwt?sec053b=${Date.now()}`
    );
    const warnings: string[] = [];
    checkJwtSecretStrength("a".repeat(32), "STEWARD_JWT_SECRET", {
      nodeEnv: "staging",
      warn: (m) => warnings.push(m),
    });
    expect(warnings.length).toBe(0);
  });

  it("getJwtSecret warns on a short configured secret in staging", async () => {
    const { getJwtSecret: freshGetJwtSecret } = await import(
      `../jwt?sec053c=${Date.now()}`
    );
    const savedSecret = process.env.STEWARD_JWT_SECRET;
    const savedEnv = process.env.NODE_ENV;
    process.env.STEWARD_JWT_SECRET = "abc123";
    process.env.NODE_ENV = "staging";
    try {
      const warnings: string[] = [];
      expect(freshGetJwtSecret({ warn: (m) => warnings.push(m) })).toBe(
        "abc123",
      );
      expect(
        warnings.some((m) => m.includes("shorter than 32 characters")),
      ).toBe(true);
    } finally {
      if (savedSecret === undefined) delete process.env.STEWARD_JWT_SECRET;
      else process.env.STEWARD_JWT_SECRET = savedSecret;
      if (savedEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedEnv;
    }
  });

  it("SessionManager rejects an explicit short secret in production (SEC-054)", async () => {
    const { SessionManager } = await import(`../session?sec054=${Date.now()}`);
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new SessionManager({ secret: "sixteen-chars-xx" })).toThrow(
        "must be at least 32 characters in production",
      );
    } finally {
      if (savedEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedEnv;
    }
  });
});
