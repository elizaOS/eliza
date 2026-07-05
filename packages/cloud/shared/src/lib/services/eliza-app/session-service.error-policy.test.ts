// Pins the fail-closed error policy of the JWT session service: an invalid
// bearer token yields the designed null "invalid session" signal, while an
// internal config failure (missing JWT secret) PROPAGATES rather than being
// masked as a null denial. Drives the real service (real jose + real config
// getter reading process.env), no mocks.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const SECRET = "test-jwt-secret-error-policy-abc123";

let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.ELIZA_APP_JWT_SECRET;
  process.env.ELIZA_APP_JWT_SECRET = SECRET;
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.ELIZA_APP_JWT_SECRET;
  else process.env.ELIZA_APP_JWT_SECRET = savedSecret;
});

describe("ElizaAppSessionService error policy", () => {
  it("round-trips a real session: created token validates back to its claims", async () => {
    const { elizaAppSessionService } = await import("./session-service");

    const { token } = await elizaAppSessionService.createSession("user-1", "org-1", {
      telegramId: "tg-9",
    });

    const validated = await elizaAppSessionService.validateSession(token);
    expect(validated).not.toBeNull();
    expect(validated?.userId).toBe("user-1");
    expect(validated?.organizationId).toBe("org-1");
    expect(validated?.telegramId).toBe("tg-9");
  });

  it("designed-invalid: a malformed/tampered token yields null (fail-closed deny), not a throw", async () => {
    const { elizaAppSessionService } = await import("./session-service");

    // Untrusted input (J3): jwtVerify rejects this. Expected result is the
    // explicit null "not a valid session" signal.
    const bogus = await elizaAppSessionService.validateSession("not-a-real-jwt.at.all");
    expect(bogus).toBeNull();

    // A token signed with a different secret is likewise an invalid token → null.
    const { SignJWT } = await import("jose");
    const foreign = await new SignJWT({ userId: "u", organizationId: "o" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("eliza-app")
      .setAudience("eliza-app-users")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-different-secret-entirely"));
    expect(await elizaAppSessionService.validateSession(foreign)).toBeNull();
  });

  it("valid-but-underspecified token (missing required claims) yields null, distinct from a valid session", async () => {
    const { elizaAppSessionService } = await import("./session-service");
    const { SignJWT } = await import("jose");

    // Correctly signed with OUR secret, but missing userId/organizationId.
    const token = await new SignJWT({ somethingElse: "x" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("eliza-app")
      .setAudience("eliza-app-users")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));

    expect(await elizaAppSessionService.validateSession(token)).toBeNull();
  });

  it("internal failure PROPAGATES: a missing JWT secret throws instead of masking as null", async () => {
    const { elizaAppSessionService } = await import("./session-service");

    // Mint a valid token first while the secret is present...
    const { token } = await elizaAppSessionService.createSession("user-2", "org-2");
    expect(await elizaAppSessionService.validateSession(token)).not.toBeNull();

    // ...then remove the secret. getSecretKey() now throws inside the config
    // getter (requireEnv). This is a server misconfiguration, NOT an invalid
    // token: it must surface as a thrown error, never a null "denied".
    delete process.env.ELIZA_APP_JWT_SECRET;

    await expect(elizaAppSessionService.validateSession(token)).rejects.toThrow(
      /ELIZA_APP_JWT_SECRET/,
    );

    // validateAuthHeader delegates to validateSession, so the config failure
    // propagates through it too (rather than degrading to a null denial).
    await expect(elizaAppSessionService.validateAuthHeader(`Bearer ${token}`)).rejects.toThrow(
      /ELIZA_APP_JWT_SECRET/,
    );
  });
});
