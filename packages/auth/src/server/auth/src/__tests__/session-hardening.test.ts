/** Exercises token expiry validation and signing-key rotation through the real session implementation. */
import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { decodeJwt, jwtVerify } from "jose";

import { signAgentToken, validateAgentTokenExpiryEnv } from "../jwt";
import { SessionManager } from "../session";

describe("validateAgentTokenExpiryEnv (SEC-134)", () => {
  const originalExpiry = process.env.AGENT_TOKEN_EXPIRY;
  const originalSecret = process.env.STEWARD_JWT_SECRET;

  afterEach(() => {
    if (originalExpiry === undefined) delete process.env.AGENT_TOKEN_EXPIRY;
    else process.env.AGENT_TOKEN_EXPIRY = originalExpiry;
    if (originalSecret === undefined) delete process.env.STEWARD_JWT_SECRET;
    else process.env.STEWARD_JWT_SECRET = originalSecret;
  });

  it("accepts valid durations", () => {
    for (const value of ["30d", "15m", "12h", "1y", "45 minutes", "2 weeks"]) {
      expect(() => validateAgentTokenExpiryEnv(value)).not.toThrow();
    }
  });

  it("rejects malformed durations", () => {
    for (const value of ["", "nope", "30", "-5d", "30d ago", "1x"]) {
      expect(() => validateAgentTokenExpiryEnv(value)).toThrow(
        /AGENT_TOKEN_EXPIRY/,
      );
    }
  });

  it("rejects durations beyond the one-year bound", () => {
    for (const value of ["2y", "400d", "53 weeks"]) {
      expect(() => validateAgentTokenExpiryEnv(value)).toThrow(
        /one-year maximum/,
      );
    }
  });

  it("reads a rotated default at token-mint time instead of module initialization", async () => {
    const firstSecret = randomBytes(32).toString("hex");
    const rotatedSecret = randomBytes(32).toString("hex");
    process.env.STEWARD_JWT_SECRET = firstSecret;
    process.env.AGENT_TOKEN_EXPIRY = "1h";
    const firstToken = await signAgentToken({
      agentId: "agent-expiry",
      tenantId: "tenant-expiry",
    });
    const first = decodeJwt(firstToken);
    process.env.STEWARD_JWT_SECRET = rotatedSecret;
    process.env.AGENT_TOKEN_EXPIRY = "5m";
    const rotatedToken = await signAgentToken({
      agentId: "agent-expiry",
      tenantId: "tenant-expiry",
    });
    const rotated = decodeJwt(rotatedToken);

    expect((first.exp ?? 0) - (first.iat ?? 0)).toBe(3600);
    expect((rotated.exp ?? 0) - (rotated.iat ?? 0)).toBe(300);
    await expect(
      jwtVerify(firstToken, new TextEncoder().encode(firstSecret)),
    ).resolves.toBeDefined();
    await expect(
      jwtVerify(rotatedToken, new TextEncoder().encode(rotatedSecret)),
    ).resolves.toBeDefined();
    await expect(
      jwtVerify(rotatedToken, new TextEncoder().encode(firstSecret)),
    ).rejects.toThrow();
  });

  it("keeps an explicit bounded TTL independent from the configured default", async () => {
    process.env.STEWARD_JWT_SECRET =
      "explicit-expiry-test-secret-at-least-32-chars";
    process.env.AGENT_TOKEN_EXPIRY = "not-a-duration";

    const token = decodeJwt(
      await signAgentToken(
        { agentId: "agent-explicit", tenantId: "tenant-explicit" },
        "10m",
      ),
    );

    expect((token.exp ?? 0) - (token.iat ?? 0)).toBe(600);
  });
});

describe("SessionManager.createSession claim precedence (SEC-134)", () => {
  const secret = "test-session-hardening-secret-at-least-32-chars";

  it("never lets extra claims override userId or pre-select a jti", async () => {
    const sessions = new SessionManager({ secret, expiresIn: "1h" });
    const token = await sessions.createSession("authenticated-user", {
      userId: "attacker-user",
      jti: "attacker-chosen-jti",
      role: "admin",
    });
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      {
        issuer: "steward",
      },
    );
    expect(payload.userId).toBe("authenticated-user");
    expect(payload.jti).not.toBe("attacker-chosen-jti");
    expect(typeof payload.jti).toBe("string");
    expect(payload.role).toBe("admin");
  });
});
