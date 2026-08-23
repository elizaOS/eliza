/**
 * Deterministic unit coverage of the Playwright e2e test-session token
 * builder: payload claims, TTL, HMAC signature, identity uniqueness, and
 * round-trip verification against the cloud-shared consumer. Drives the real
 * module; the worker-scoped stack boot and SIWE login fixtures are not
 * invoked here because they start the full local cloud stack.
 */

import { createHmac } from "node:crypto";
import { verifyPlaywrightTestSessionToken } from "@elizaos/cloud-shared/lib/auth/playwright-test-session";
import { describe, expect, test, vi } from "vitest";
import { PLAYWRIGHT_TEST_AUTH_SECRET } from "../fixtures/env";
import {
  buildPlaywrightSessionToken,
  expect as cloudExpect,
  test as cloudTest,
} from "./test-fixtures";

// The Playwright fixture file statically imports the full cloud-stack boot
// graph. Vitest's root alias rewrites `@elizaos/core/edge` to a missing
// `src/edge` path, so the collector never reaches the token builder unless
// that graph is stubbed. The stubs throw if a fixture body is invoked; the
// assertions below drive the real HMAC builder only.
vi.mock("../fixtures/stack", () => ({
  startCloudStack: async () => {
    throw new Error("startCloudStack is not invoked by this unit suite");
  },
}));

vi.mock("./wallet-login", () => ({
  loginAsSeededUser: async () => {
    throw new Error("loginAsSeededUser is not invoked by this unit suite");
  },
}));

const SESSION_TTL_SECONDS = 60 * 60;

const VERIFY_ENV = {
  PLAYWRIGHT_TEST_AUTH: "true",
  PLAYWRIGHT_TEST_AUTH_SECRET,
} as const;

function decodeToken(token: string): {
  payload: string;
  signature: string;
  claims: { userId: string; organizationId: string; exp: number };
} {
  const parts = token.split(".");
  expect(parts).toHaveLength(2);
  const [payload, signature] = parts;
  expect(payload).toBeTruthy();
  expect(signature).toBeTruthy();
  const claims = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as {
    userId: string;
    organizationId: string;
    exp: number;
  };
  return { payload, signature, claims };
}

function expectedSignature(payload: string): string {
  return createHmac("sha256", PLAYWRIGHT_TEST_AUTH_SECRET)
    .update(payload)
    .digest("base64url");
}

describe("buildPlaywrightSessionToken", () => {
  test("encodes userId, organizationId, and a one-hour exp as payload.signature", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = buildPlaywrightSessionToken("user-alpha", "org-beta");
    const after = Math.floor(Date.now() / 1000);
    const { payload, signature, claims } = decodeToken(token);

    expect(token).toBe(`${payload}.${signature}`);
    expect(claims).toEqual({
      userId: "user-alpha",
      organizationId: "org-beta",
      exp: claims.exp,
    });
    expect(claims.exp).toBeGreaterThanOrEqual(before + SESSION_TTL_SECONDS);
    expect(claims.exp).toBeLessThanOrEqual(after + SESSION_TTL_SECONDS);
    expect(signature).toBe(expectedSignature(payload));
  });

  test("signs the base64url payload with PLAYWRIGHT_TEST_AUTH_SECRET HMAC-SHA256", () => {
    const token = buildPlaywrightSessionToken("user-1", "org-1");
    const { payload, signature } = decodeToken(token);
    const independent = createHmac("sha256", PLAYWRIGHT_TEST_AUTH_SECRET)
      .update(payload)
      .digest("base64url");
    expect(signature).toBe(independent);
    expect(PLAYWRIGHT_TEST_AUTH_SECRET.length).toBeGreaterThanOrEqual(16);
  });

  test("is stable for the same identity within the same unix second", () => {
    const first = buildPlaywrightSessionToken("user-stable", "org-stable");
    const second = buildPlaywrightSessionToken("user-stable", "org-stable");
    const firstExp = decodeToken(first).claims.exp;
    const secondExp = decodeToken(second).claims.exp;
    if (firstExp === secondExp) {
      expect(second).toBe(first);
    } else {
      expect(secondExp).toBe(firstExp + 1);
    }
  });

  test("different userIds produce different payloads and signatures", () => {
    const left = buildPlaywrightSessionToken("user-a", "org-shared");
    const right = buildPlaywrightSessionToken("user-b", "org-shared");
    const leftDecoded = decodeToken(left);
    const rightDecoded = decodeToken(right);
    expect(left).not.toBe(right);
    expect(leftDecoded.claims.userId).toBe("user-a");
    expect(rightDecoded.claims.userId).toBe("user-b");
    expect(leftDecoded.claims.organizationId).toBe("org-shared");
    expect(rightDecoded.claims.organizationId).toBe("org-shared");
    expect(leftDecoded.payload).not.toBe(rightDecoded.payload);
    expect(leftDecoded.signature).not.toBe(rightDecoded.signature);
  });

  test("different organizationIds produce different payloads and signatures", () => {
    const left = buildPlaywrightSessionToken("user-shared", "org-a");
    const right = buildPlaywrightSessionToken("user-shared", "org-b");
    const leftDecoded = decodeToken(left);
    const rightDecoded = decodeToken(right);
    expect(left).not.toBe(right);
    expect(leftDecoded.claims.organizationId).toBe("org-a");
    expect(rightDecoded.claims.organizationId).toBe("org-b");
    expect(leftDecoded.payload).not.toBe(rightDecoded.payload);
    expect(leftDecoded.signature).not.toBe(rightDecoded.signature);
  });

  test("round-trips unicode and UUID-shaped identities through JSON claims", () => {
    const userId = "ユーザー-✨-550e8400-e29b-41d4-a716-446655440000";
    const organizationId = "org/with space+plus";
    const { claims } = decodeToken(
      buildPlaywrightSessionToken(userId, organizationId),
    );
    expect(claims.userId).toBe(userId);
    expect(claims.organizationId).toBe(organizationId);
  });

  test("encodes empty-string identities without validating them", () => {
    const { claims } = decodeToken(buildPlaywrightSessionToken("", ""));
    expect(claims.userId).toBe("");
    expect(claims.organizationId).toBe("");
  });

  test("is accepted by the cloud-shared verifier with the e2e secret", () => {
    const token = buildPlaywrightSessionToken("user-verify", "org-verify");
    expect(verifyPlaywrightTestSessionToken(token, VERIFY_ENV)).toEqual({
      userId: "user-verify",
      organizationId: "org-verify",
      exp: decodeToken(token).claims.exp,
    });
  });

  test("empty-string identities are encoded but rejected by the verifier", () => {
    const token = buildPlaywrightSessionToken("", "org-only");
    expect(decodeToken(token).claims.userId).toBe("");
    expect(verifyPlaywrightTestSessionToken(token, VERIFY_ENV)).toBeNull();

    const orgEmpty = buildPlaywrightSessionToken("user-only", "");
    expect(decodeToken(orgEmpty).claims.organizationId).toBe("");
    expect(verifyPlaywrightTestSessionToken(orgEmpty, VERIFY_ENV)).toBeNull();
  });

  test("does not verify against a different secret or a tampered signature", () => {
    const token = buildPlaywrightSessionToken("user-tamper", "org-tamper");
    const { payload, signature } = decodeToken(token);
    const flipped =
      signature[0] === "A"
        ? `B${signature.slice(1)}`
        : `A${signature.slice(1)}`;

    expect(
      verifyPlaywrightTestSessionToken(token, {
        PLAYWRIGHT_TEST_AUTH: "true",
        PLAYWRIGHT_TEST_AUTH_SECRET: "a-different-secret-32bytes-long",
      }),
    ).toBeNull();
    expect(
      verifyPlaywrightTestSessionToken(`${payload}.${flipped}`, VERIFY_ENV),
    ).toBeNull();
    expect(
      verifyPlaywrightTestSessionToken(`${token}.extra`, VERIFY_ENV),
    ).toBeNull();
  });
});

describe("playwright fixture re-exports", () => {
  test("re-exports Playwright test and expect from the extended fixture", () => {
    expect(typeof cloudTest).toBe("function");
    expect(typeof cloudExpect).toBe("function");
    expect(typeof cloudTest.extend).toBe("function");
    expect(typeof cloudTest.skip).toBe("function");
    expect(typeof cloudTest.use).toBe("function");
  });
});
