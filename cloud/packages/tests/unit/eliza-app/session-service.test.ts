/**
 * Eliza App Session Service Tests
 *
 * Tests JWT session creation and validation:
 * - Token creation with proper claims
 * - Token validation and payload extraction
 * - Expired token handling
 * - Invalid token handling
 * - Authorization header parsing
 */

import { describe, expect, test } from "bun:test";
import { jwtVerify, SignJWT } from "jose";

// Test configuration matching session-service.ts
const JWT_ISSUER = "eliza-app";
const JWT_AUDIENCE = "eliza-app-users";
const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60; // 7 days
const TEST_SECRET = "test-secret-key-at-least-32-characters-long";

const secretKey = new TextEncoder().encode(TEST_SECRET);

/**
 * Create a test JWT token
 */
async function createTestToken(
  payload: {
    userId: string;
    organizationId: string;
    telegramId?: string;
    phoneNumber?: string;
  },
  options?: {
    expiresInSeconds?: number;
    issuer?: string;
    audience?: string;
  },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options?.expiresInSeconds ?? SESSION_DURATION_SECONDS;

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .setIssuer(options?.issuer ?? JWT_ISSUER)
    .setAudience(options?.audience ?? JWT_AUDIENCE)
    .setSubject(payload.userId)
    .sign(secretKey);
}

/**
 * Verify a test JWT token
 */
async function verifyTestToken(token: string) {
  return jwtVerify(token, secretKey, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

describe("JWT Token Creation", () => {
  test("creates valid JWT with required fields", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
    });

    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3); // header.payload.signature
  });

  test("token contains correct payload fields", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
      telegramId: "tg-789",
    });

    const { payload } = await verifyTestToken(token);

    expect(payload.userId).toBe("user-123");
    expect(payload.organizationId).toBe("org-456");
    expect(payload.telegramId).toBe("tg-789");
  });

  test("token has correct issuer", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
    });

    const { payload } = await verifyTestToken(token);
    expect(payload.iss).toBe(JWT_ISSUER);
  });

  test("token has correct audience", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
    });

    const { payload } = await verifyTestToken(token);
    expect(payload.aud).toBe(JWT_AUDIENCE);
  });

  test("token has correct subject (userId)", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
    });

    const { payload } = await verifyTestToken(token);
    expect(payload.sub).toBe("user-123");
  });

  test("token has iat (issued at) claim", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
    });
    const after = Math.floor(Date.now() / 1000);

    const { payload } = await verifyTestToken(token);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
  });

  test("token has exp (expiration) claim", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
    });

    const { payload } = await verifyTestToken(token);
    const expectedExp = now + SESSION_DURATION_SECONDS;

    // Allow 5 second tolerance for test execution time
    expect(payload.exp).toBeGreaterThanOrEqual(expectedExp - 5);
    expect(payload.exp).toBeLessThanOrEqual(expectedExp + 5);
  });

  test("optional telegramId is included when provided", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
      telegramId: "223116693",
    });

    const { payload } = await verifyTestToken(token);
    expect(payload.telegramId).toBe("223116693");
  });

  test("optional phoneNumber is included when provided", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
      phoneNumber: "+14155551234",
    });

    const { payload } = await verifyTestToken(token);
    expect(payload.phoneNumber).toBe("+14155551234");
  });

  test("optional fields are absent when not provided", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
    });

    const { payload } = await verifyTestToken(token);
    expect(payload.telegramId).toBeUndefined();
    expect(payload.phoneNumber).toBeUndefined();
  });
});

describe("JWT Token Validation", () => {
  test("valid token passes verification", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
    });

    const result = await verifyTestToken(token);
    expect(result.payload.userId).toBe("user-123");
  });

  test("expired token throws error", async () => {
    const token = await createTestToken(
      { userId: "user-123", organizationId: "org-456" },
      { expiresInSeconds: -3600 }, // Expired 1 hour ago
    );

    await expect(verifyTestToken(token)).rejects.toThrow();
  });

  test("token with wrong issuer is rejected", async () => {
    const token = await createTestToken(
      { userId: "user-123", organizationId: "org-456" },
      { issuer: "wrong-issuer" },
    );

    await expect(verifyTestToken(token)).rejects.toThrow();
  });

  test("token with wrong audience is rejected", async () => {
    const token = await createTestToken(
      { userId: "user-123", organizationId: "org-456" },
      { audience: "wrong-audience" },
    );

    await expect(verifyTestToken(token)).rejects.toThrow();
  });

  test("tampered token is rejected", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
    });

    // Tamper with the payload
    const [header, , signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ userId: "hacker", organizationId: "evil" }),
    ).toString("base64url");
    const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

    await expect(verifyTestToken(tamperedToken)).rejects.toThrow();
  });

  test("malformed token is rejected", async () => {
    await expect(verifyTestToken("not-a-valid-jwt")).rejects.toThrow();
  });

  test("empty string token is rejected", async () => {
    await expect(verifyTestToken("")).rejects.toThrow();
  });

  test("token signed with wrong key is rejected", async () => {
    const wrongKey = new TextEncoder().encode("wrong-secret-key-32-chars-long!!");

    const token = await new SignJWT({
      userId: "user-123",
      organizationId: "org-456",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .sign(wrongKey);

    await expect(verifyTestToken(token)).rejects.toThrow();
  });
});

describe("Authorization Header Parsing", () => {
  test("extracts token from 'Bearer <token>' format", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.test.signature";
    const authHeader = `Bearer ${token}`;

    expect(authHeader.startsWith("Bearer ")).toBe(true);
    expect(authHeader.slice(7)).toBe(token);
  });

  test("rejects non-Bearer auth schemes", () => {
    const authHeader = "Basic dXNlcjpwYXNz";
    expect(authHeader.startsWith("Bearer ")).toBe(false);
  });

  test("handles 'bearer' lowercase", () => {
    const authHeader = "bearer token123";
    // Service should be case-sensitive for Bearer
    expect(authHeader.startsWith("Bearer ")).toBe(false);
  });

  test("handles extra whitespace after Bearer", () => {
    const authHeader = "Bearer   token123";
    // When slicing at position 7, we get "  token123"
    expect(authHeader.slice(7)).toBe("  token123");
    // Proper implementation should trim
    expect(authHeader.slice(7).trim()).toBe("token123");
  });

  test("handles missing token after Bearer", () => {
    const authHeader = "Bearer ";
    const token = authHeader.slice(7);
    expect(token).toBe("");
  });
});

describe("Session Duration", () => {
  test("SESSION_DURATION_SECONDS is 7 days", () => {
    const sevenDaysInSeconds = 7 * 24 * 60 * 60;
    expect(SESSION_DURATION_SECONDS).toBe(sevenDaysInSeconds);
    expect(SESSION_DURATION_SECONDS).toBe(604800);
  });

  test("token expires in approximately 7 days", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
    });

    const { payload } = await verifyTestToken(token);
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = (payload.exp as number) - now;

    // Should be within 10 seconds of 7 days
    expect(expiresIn).toBeGreaterThan(SESSION_DURATION_SECONDS - 10);
    expect(expiresIn).toBeLessThanOrEqual(SESSION_DURATION_SECONDS);
  });
});

describe("Edge Cases", () => {
  test("handles UUID-format userId", async () => {
    const token = await createTestToken({
      userId: "550e8400-e29b-41d4-a716-446655440000",
      organizationId: "org-456",
    });

    const { payload } = await verifyTestToken(token);
    expect(payload.userId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("handles special characters in organizationId", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org_test-123.abc",
    });

    const { payload } = await verifyTestToken(token);
    expect(payload.organizationId).toBe("org_test-123.abc");
  });

  test("handles international phone numbers", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
      phoneNumber: "+442071234567", // UK number
    });

    const { payload } = await verifyTestToken(token);
    expect(payload.phoneNumber).toBe("+442071234567");
  });

  test("handles large telegramId (64-bit)", async () => {
    const token = await createTestToken({
      userId: "user-123",
      organizationId: "org-456",
      telegramId: "9007199254740991", // Near MAX_SAFE_INTEGER
    });

    const { payload } = await verifyTestToken(token);
    expect(payload.telegramId).toBe("9007199254740991");
  });
});
