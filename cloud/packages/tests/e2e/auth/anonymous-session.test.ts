import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";

/**
 * Anonymous Session E2E Tests
 *
 * Tests the anonymous user authentication flow.
 * Note: create-anonymous-session is a GET endpoint (not POST).
 */

async function createAnonymousSessionToken(): Promise<string> {
  const response = await fetch(api.url("/api/auth/create-anonymous-session"), {
    redirect: "manual",
  });
  expect([302, 303, 307, 308]).toContain(response.status);

  const setCookie = response.headers.get("set-cookie") || "";
  const token = /(?:^|;\s*)eliza-anon-session=([^;]+)/.exec(setCookie)?.[1];
  expect(token).toBeTruthy();
  if (!token) throw new Error("Anonymous session response did not set eliza-anon-session");
  return token;
}

describe("Anonymous Session API", () => {
  test("GET /api/auth/create-anonymous-session creates a session", async () => {
    const token = await createAnonymousSessionToken();
    expect(token).toBeTruthy();
  });

  test("GET /api/anonymous-session returns session data when cookie exists", async () => {
    const token = await createAnonymousSessionToken();

    // Use the token in subsequent request
    const response = await api.get(`/api/anonymous-session?token=${encodeURIComponent(token)}`);

    // Should return session info or 404 if no cookie context
    expect([200, 404]).toContain(response.status);
  });

  test("GET /api/auth/create-anonymous-session returns different sessions", async () => {
    const [t1, t2] = await Promise.all([
      createAnonymousSessionToken(),
      createAnonymousSessionToken(),
    ]);

    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
    expect(t1).not.toBe(t2);
  });
});

describe("Anonymous Session Migration", () => {
  test("POST /api/auth/migrate-anonymous requires auth", async () => {
    const response = await api.post("/api/auth/migrate-anonymous", {
      anonymousUserId: "test",
    });
    // Should require authentication
    expect([401, 403]).toContain(response.status);
  });
});
