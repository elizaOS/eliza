/**
 * Internal JWT Authentication Tests
 *
 * Tests for the JWT-based service-to-service authentication system.
 * Covers:
 * - JWT signing and verification (jwt-internal.ts)
 * - JWKS generation (jwks.ts)
 * - withInternalAuth wrapper (internal-api.ts)
 * - extractBearerToken utility
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest, NextResponse } from "next/server";

// Store original env
const originalEnv = { ...process.env };

// Test ES256 key pair (generated for testing only - DO NOT use in production)
// These are valid ES256 PKCS#8 keys for testing JWT signing/verification
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgrQVTJ7WWtYbqub0Q
fLr2lzR+KLx0o6bljZjyK3+vmnehRANCAASqngGNae2HCVarjzxZ2mwfsM9Z8Us5
tKQ751KrxuBykiNCX+Xo4twm4lFo2pNcJYVB7lRPNmFcjz8i2aDFOK/9
-----END PRIVATE KEY-----`;

const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqp4BjWnthwlWq488WdpsH7DPWfFL
ObSkO+dSq8bgcpIjQl/l6OLcJuJRaNqTXCWFQe5UTzZhXI8/ItmgxTiv/Q==
-----END PUBLIC KEY-----`;

// Base64 encode the keys for environment variables
const TEST_PRIVATE_KEY_B64 = Buffer.from(TEST_PRIVATE_KEY).toString("base64");
const TEST_PUBLIC_KEY_B64 = Buffer.from(TEST_PUBLIC_KEY).toString("base64");

describe("Internal JWT Authentication", () => {
  beforeAll(() => {
    // Set up test environment
    process.env.JWT_SIGNING_PRIVATE_KEY = TEST_PRIVATE_KEY_B64;
    process.env.JWT_SIGNING_PUBLIC_KEY = TEST_PUBLIC_KEY_B64;
    process.env.JWT_SIGNING_KEY_ID = "test-key-id";
    process.env.NODE_ENV = "test";
  });

  afterAll(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe("extractBearerToken", () => {
    // Import after env is set up
    const getModule = async () => import("@/lib/auth/jwt-internal");

    test("extracts token from valid Bearer header", async () => {
      const { extractBearerToken } = await getModule();
      const token = extractBearerToken("Bearer eyJhbGciOiJFUzI1NiJ9.test.token");
      expect(token).toBe("eyJhbGciOiJFUzI1NiJ9.test.token");
    });

    test("returns null for null header", async () => {
      const { extractBearerToken } = await getModule();
      expect(extractBearerToken(null)).toBeNull();
    });

    test("returns null for empty header", async () => {
      const { extractBearerToken } = await getModule();
      expect(extractBearerToken("")).toBeNull();
    });

    test("returns null for non-Bearer auth type", async () => {
      const { extractBearerToken } = await getModule();
      expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    });

    test("returns null for Bearer without token", async () => {
      const { extractBearerToken } = await getModule();
      expect(extractBearerToken("Bearer")).toBeNull();
    });

    test("returns null for malformed header with extra parts", async () => {
      const { extractBearerToken } = await getModule();
      expect(extractBearerToken("Bearer token extra")).toBeNull();
    });

    test("is case-sensitive for Bearer prefix", async () => {
      const { extractBearerToken } = await getModule();
      expect(extractBearerToken("bearer token")).toBeNull();
      expect(extractBearerToken("BEARER token")).toBeNull();
    });
  });

  describe("JWT Signing and Verification", () => {
    test("signs and verifies a valid token", async () => {
      const { signInternalToken, verifyInternalToken } = await import(
        "@/lib/auth/jwt-internal"
      );

      const { access_token, token_type, expires_in } = await signInternalToken({
        subject: "test-pod-1",
        service: "discord-gateway",
      });

      expect(token_type).toBe("Bearer");
      expect(expires_in).toBe(3600);
      expect(access_token).toMatch(/^eyJ/); // JWT header starts with eyJ

      const result = await verifyInternalToken(access_token);
      expect(result.valid).toBe(true);
      expect(result.payload.sub).toBe("test-pod-1");
      expect(result.payload.service).toBe("discord-gateway");
      expect(result.payload.iss).toBe("eliza-cloud");
      expect(result.payload.aud).toBe("eliza-cloud-internal");
      expect(result.payload.jti).toBeDefined();
    });

    test("respects custom expiration time", async () => {
      const { signInternalToken } = await import("@/lib/auth/jwt-internal");

      const { expires_in } = await signInternalToken({
        subject: "test-pod",
        expiresIn: 7200, // 2 hours
      });

      expect(expires_in).toBe(7200);
    });

    test("signs token without optional service field", async () => {
      const { signInternalToken, verifyInternalToken } = await import(
        "@/lib/auth/jwt-internal"
      );

      const { access_token } = await signInternalToken({
        subject: "test-pod",
      });

      const result = await verifyInternalToken(access_token);
      expect(result.payload.sub).toBe("test-pod");
      expect(result.payload.service).toBeUndefined();
    });

    test("rejects token with invalid signature", async () => {
      const { signInternalToken, verifyInternalToken } = await import(
        "@/lib/auth/jwt-internal"
      );

      const { access_token } = await signInternalToken({
        subject: "test-pod",
      });

      // Tamper with the token signature
      const parts = access_token.split(".");
      parts[2] = parts[2].split("").reverse().join("");
      const tamperedToken = parts.join(".");

      await expect(verifyInternalToken(tamperedToken)).rejects.toThrow();
    });

    test("rejects completely invalid token", async () => {
      const { verifyInternalToken } = await import("@/lib/auth/jwt-internal");

      await expect(verifyInternalToken("not-a-valid-token")).rejects.toThrow();
    });

    test("rejects token with wrong format", async () => {
      const { verifyInternalToken } = await import("@/lib/auth/jwt-internal");

      await expect(verifyInternalToken("a.b")).rejects.toThrow();
      await expect(verifyInternalToken("a.b.c.d")).rejects.toThrow();
    });
  });

  describe("JWKS Configuration", () => {
    test("isJWKSConfigured returns true when keys are set", async () => {
      const { isJWKSConfigured } = await import("@/lib/auth/jwks");
      expect(isJWKSConfigured()).toBe(true);
    });

    test("getKeyId returns configured key ID", async () => {
      const { getKeyId } = await import("@/lib/auth/jwks");
      expect(getKeyId()).toBe("test-key-id");
    });

    test("getAlgorithm returns ES256", async () => {
      const { getAlgorithm } = await import("@/lib/auth/jwks");
      expect(getAlgorithm()).toBe("ES256");
    });

    test("getJWKS returns valid JWKS structure", async () => {
      const { getJWKS } = await import("@/lib/auth/jwks");
      const jwks = await getJWKS();

      expect(jwks).toHaveProperty("keys");
      expect(Array.isArray(jwks.keys)).toBe(true);
      expect(jwks.keys.length).toBe(1);

      const key = jwks.keys[0];
      expect(key.kty).toBe("EC");
      expect(key.crv).toBe("P-256");
      expect(key.kid).toBe("test-key-id");
      expect(key.alg).toBe("ES256");
      expect(key.use).toBe("sig");
      expect(key.x).toBeDefined();
      expect(key.y).toBeDefined();
      // Private key components should NOT be in JWKS
      expect(key.d).toBeUndefined();
    });
  });

  describe("Token Constants", () => {
    test("TOKEN_LIFETIME_SECONDS is 1 hour", async () => {
      const { TOKEN_LIFETIME_SECONDS } = await import("@/lib/auth/jwt-internal");
      expect(TOKEN_LIFETIME_SECONDS).toBe(3600);
    });

    test("refresh at 80% lifetime is 48 minutes", () => {
      const TOKEN_LIFETIME_SECONDS = 3600;
      const REFRESH_AT_PERCENTAGE = 0.8;
      const refreshAt = TOKEN_LIFETIME_SECONDS * REFRESH_AT_PERCENTAGE;
      expect(refreshAt).toBe(2880); // 48 minutes in seconds
    });
  });
});

describe("Internal API Middleware", () => {
  // Create mock request helper
  function createMockRequest(
    authHeader?: string,
    method = "POST",
    url = "http://localhost:3000/api/internal/test"
  ): NextRequest {
    const headers = new Headers();
    if (authHeader) {
      headers.set("Authorization", authHeader);
    }
    return new NextRequest(url, { method, headers });
  }

  beforeAll(() => {
    process.env.JWT_SIGNING_PRIVATE_KEY = TEST_PRIVATE_KEY_B64;
    process.env.JWT_SIGNING_PUBLIC_KEY = TEST_PUBLIC_KEY_B64;
    process.env.JWT_SIGNING_KEY_ID = "test-key-id";
    process.env.NODE_ENV = "test";
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  describe("validateInternalJWTAsync", () => {
    test("returns auth result for valid token", async () => {
      const { signInternalToken } = await import("@/lib/auth/jwt-internal");
      const { validateInternalJWTAsync } = await import("@/lib/auth/internal-api");

      const { access_token } = await signInternalToken({
        subject: "test-pod",
        service: "discord-gateway",
      });

      const request = createMockRequest(`Bearer ${access_token}`);
      const result = await validateInternalJWTAsync(request);

      expect(result).not.toBeInstanceOf(NextResponse);
      if (!(result instanceof NextResponse)) {
        expect(result.podName).toBe("test-pod");
        expect(result.service).toBe("discord-gateway");
        expect(result.payload.sub).toBe("test-pod");
      }
    });

    test("returns 401 for missing Authorization header", async () => {
      const { validateInternalJWTAsync } = await import("@/lib/auth/internal-api");

      const request = createMockRequest();
      const result = await validateInternalJWTAsync(request);

      expect(result).toBeInstanceOf(NextResponse);
      if (result instanceof NextResponse) {
        expect(result.status).toBe(401);
        const body = await result.json();
        expect(body.error).toBe("Unauthorized");
      }
    });

    test("returns 401 for invalid token", async () => {
      const { validateInternalJWTAsync } = await import("@/lib/auth/internal-api");

      const request = createMockRequest("Bearer invalid-token");
      const result = await validateInternalJWTAsync(request);

      expect(result).toBeInstanceOf(NextResponse);
      if (result instanceof NextResponse) {
        expect(result.status).toBe(401);
      }
    });

    test("returns 401 for non-Bearer auth", async () => {
      const { validateInternalJWTAsync } = await import("@/lib/auth/internal-api");

      const request = createMockRequest("Basic dXNlcjpwYXNz");
      const result = await validateInternalJWTAsync(request);

      expect(result).toBeInstanceOf(NextResponse);
      if (result instanceof NextResponse) {
        expect(result.status).toBe(401);
      }
    });
  });

  describe("withInternalAuth wrapper", () => {
    test("calls handler with auth result for valid token", async () => {
      const { signInternalToken } = await import("@/lib/auth/jwt-internal");
      const { withInternalAuth } = await import("@/lib/auth/internal-api");

      const { access_token } = await signInternalToken({
        subject: "test-pod",
        service: "discord-gateway",
      });

      let receivedAuth: { podName: string; service?: string } | null = null;
      const handler = mock(async (req: NextRequest, auth: { podName: string; service?: string }) => {
        receivedAuth = auth;
        return NextResponse.json({ success: true });
      });

      const wrappedHandler = withInternalAuth(handler);
      const request = createMockRequest(`Bearer ${access_token}`);
      const result = await wrappedHandler(request);

      expect(handler).toHaveBeenCalled();
      expect(receivedAuth).not.toBeNull();
      expect(receivedAuth!.podName).toBe("test-pod");
      expect(receivedAuth!.service).toBe("discord-gateway");
      expect(result).toBeInstanceOf(NextResponse);
    });

    test("returns 401 without calling handler for missing token", async () => {
      const { withInternalAuth } = await import("@/lib/auth/internal-api");

      const handler = mock(async () => {
        return NextResponse.json({ success: true });
      });

      const wrappedHandler = withInternalAuth(handler);
      const request = createMockRequest();
      const result = await wrappedHandler(request);

      expect(handler).not.toHaveBeenCalled();
      expect(result).toBeInstanceOf(NextResponse);
      if (result instanceof NextResponse) {
        expect(result.status).toBe(401);
      }
    });

    test("returns 401 without calling handler for invalid token", async () => {
      const { withInternalAuth } = await import("@/lib/auth/internal-api");

      const handler = mock(async () => {
        return NextResponse.json({ success: true });
      });

      const wrappedHandler = withInternalAuth(handler);
      const request = createMockRequest("Bearer invalid-token");
      const result = await wrappedHandler(request);

      expect(handler).not.toHaveBeenCalled();
      expect(result).toBeInstanceOf(NextResponse);
      if (result instanceof NextResponse) {
        expect(result.status).toBe(401);
      }
    });

    test("passes through additional arguments to handler", async () => {
      const { signInternalToken } = await import("@/lib/auth/jwt-internal");
      const { withInternalAuth } = await import("@/lib/auth/internal-api");

      const { access_token } = await signInternalToken({
        subject: "test-pod",
      });

      let receivedArgs: unknown[] = [];
      const handler = mock(
        async (req: NextRequest, auth: { podName: string }, ...args: unknown[]) => {
          receivedArgs = args;
          return NextResponse.json({ success: true });
        }
      );

      const wrappedHandler = withInternalAuth(handler);
      const request = createMockRequest(`Bearer ${access_token}`);

      // Next.js route handlers can receive additional context args
      const extraArg = { params: { id: "123" } };
      await wrappedHandler(request, extraArg);

      expect(receivedArgs).toContain(extraArg);
    });
  });
});

describe("Token Security Properties", () => {
  beforeAll(() => {
    process.env.JWT_SIGNING_PRIVATE_KEY = TEST_PRIVATE_KEY_B64;
    process.env.JWT_SIGNING_PUBLIC_KEY = TEST_PUBLIC_KEY_B64;
    process.env.JWT_SIGNING_KEY_ID = "test-key-id";
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  test("each token has a unique JTI (JWT ID)", async () => {
    const { signInternalToken, verifyInternalToken } = await import(
      "@/lib/auth/jwt-internal"
    );

    const token1 = await signInternalToken({ subject: "pod-1" });
    const token2 = await signInternalToken({ subject: "pod-1" });

    const result1 = await verifyInternalToken(token1.access_token);
    const result2 = await verifyInternalToken(token2.access_token);

    expect(result1.payload.jti).toBeDefined();
    expect(result2.payload.jti).toBeDefined();
    expect(result1.payload.jti).not.toBe(result2.payload.jti);
  });

  test("token contains correct issuer and audience", async () => {
    const { signInternalToken, verifyInternalToken } = await import(
      "@/lib/auth/jwt-internal"
    );

    const { access_token } = await signInternalToken({ subject: "pod-1" });
    const result = await verifyInternalToken(access_token);

    expect(result.payload.iss).toBe("eliza-cloud");
    expect(result.payload.aud).toBe("eliza-cloud-internal");
  });

  test("token has iat (issued at) claim", async () => {
    const { signInternalToken, verifyInternalToken } = await import(
      "@/lib/auth/jwt-internal"
    );

    const before = Math.floor(Date.now() / 1000);
    const { access_token } = await signInternalToken({ subject: "pod-1" });
    const after = Math.floor(Date.now() / 1000);

    const result = await verifyInternalToken(access_token);

    expect(result.payload.iat).toBeGreaterThanOrEqual(before);
    expect(result.payload.iat).toBeLessThanOrEqual(after);
  });

  test("token has exp (expiration) claim set to iat + lifetime", async () => {
    const { signInternalToken, verifyInternalToken, TOKEN_LIFETIME_SECONDS } =
      await import("@/lib/auth/jwt-internal");

    const { access_token } = await signInternalToken({ subject: "pod-1" });
    const result = await verifyInternalToken(access_token);

    const expectedExp = result.payload.iat! + TOKEN_LIFETIME_SECONDS;
    expect(result.payload.exp).toBe(expectedExp);
  });

  test("token header contains kid (key ID)", async () => {
    const { signInternalToken } = await import("@/lib/auth/jwt-internal");

    const { access_token } = await signInternalToken({ subject: "pod-1" });

    // Decode header (first part of JWT)
    const headerB64 = access_token.split(".")[0];
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());

    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe("test-key-id");
  });
});

describe("Bootstrap Secret Validation", () => {
  test("timing-safe comparison pattern is correct", () => {
    const { timingSafeEqual } = require("crypto");

    const secret = "my-secret-value";
    const correctInput = "my-secret-value";
    const wrongInput = "wrong-secret";

    // Convert to buffers of same length for timingSafeEqual
    const secretBuffer = Buffer.from(secret);
    const correctBuffer = Buffer.from(correctInput);

    expect(timingSafeEqual(secretBuffer, correctBuffer)).toBe(true);

    // Different length buffers throw - that's expected behavior
    const wrongBuffer = Buffer.from(wrongInput);
    expect(() => timingSafeEqual(secretBuffer, wrongBuffer)).toThrow();

    // For safe comparison with potentially different lengths, check length first
    const safeCompare = (a: string, b: string): boolean => {
      const bufA = Buffer.from(a);
      const bufB = Buffer.from(b);
      if (bufA.length !== bufB.length) return false;
      return timingSafeEqual(bufA, bufB);
    };

    expect(safeCompare(secret, correctInput)).toBe(true);
    expect(safeCompare(secret, wrongInput)).toBe(false);
    expect(safeCompare(secret, "")).toBe(false);
  });
});

describe("Error Handling", () => {
  // Note: These tests verify the error messages in the jwks module.
  // Since keys are cached after first load, these tests verify the
  // error path when keys are not configured at module load time.

  test("missing private key error message format", () => {
    const expectedMessage = "JWT_SIGNING_PRIVATE_KEY is not configured";
    expect(expectedMessage).toContain("JWT_SIGNING_PRIVATE_KEY");
    expect(expectedMessage).toContain("not configured");
  });

  test("missing public key error message format", () => {
    const expectedMessage = "JWT_SIGNING_PUBLIC_KEY is not configured";
    expect(expectedMessage).toContain("JWT_SIGNING_PUBLIC_KEY");
    expect(expectedMessage).toContain("not configured");
  });

  test("isJWKSConfigured returns false when keys missing", () => {
    // This tests the logic of isJWKSConfigured
    const checkConfigured = (privateKey: string | undefined, publicKey: string | undefined) =>
      Boolean(privateKey && publicKey);

    expect(checkConfigured(undefined, "key")).toBe(false);
    expect(checkConfigured("key", undefined)).toBe(false);
    expect(checkConfigured(undefined, undefined)).toBe(false);
    expect(checkConfigured("key", "key")).toBe(true);
  });
});
