// @vitest-environment jsdom

/**
 * Steward auth-endpoint resolution and token-expiry helpers: staging/prod app
 * hosts route directly to their api worker (never same-origin), unknown hosts
 * fall back to the same-origin relative path, and `tokenIsExpired` reads the
 * JWT `exp` claim.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenIsExpired } from "./StewardProviderShared";

// The Steward auth endpoints are resolved per browser host: co-hosted cloud
// surfaces bypass the Pages/Worker proxy and call the matching API worker
// directly. The invariant under guard: `staging.elizacloud.ai` MUST map to
// api-staging (not prod api, not the same-origin relative path). Without a
// direct mapping, session-sync + refresh fall through to a stale worker proxy
// that 401s and wipes a valid session — the sign-in loop.

function setHostname(hostname: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      hostname,
      origin: `https://${hostname}`,
      href: `https://${hostname}/`,
    },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadEndpoints() {
  // Neutralize any configured API base so the host-based branch is exercised.
  vi.stubEnv("VITE_API_URL", "");
  vi.stubEnv("NEXT_PUBLIC_API_URL", "");
  vi.resetModules();
  return import("./StewardProviderShared");
}

describe("Steward auth endpoint resolution", () => {
  it("routes staging to the api-staging worker directly (not prod, not same-origin)", async () => {
    setHostname("staging.elizacloud.ai");
    const { configuredSessionEndpoint, configuredRefreshEndpoint } =
      await loadEndpoints();

    expect(configuredSessionEndpoint()).toBe(
      "https://api-staging.elizacloud.ai/api/auth/steward-session",
    );
    expect(configuredRefreshEndpoint()).toBe(
      "https://api-staging.elizacloud.ai/api/auth/steward-refresh",
    );
  });

  it("routes the staging app host to the api-staging worker directly", async () => {
    setHostname("app-staging.elizacloud.ai");
    const { configuredSessionEndpoint, configuredRefreshEndpoint } =
      await loadEndpoints();

    expect(configuredSessionEndpoint()).toBe(
      "https://api-staging.elizacloud.ai/api/auth/steward-session",
    );
    expect(configuredRefreshEndpoint()).toBe(
      "https://api-staging.elizacloud.ai/api/auth/steward-refresh",
    );
  });

  it("routes prod to the prod api worker directly", async () => {
    setHostname("elizacloud.ai");
    const { configuredSessionEndpoint, configuredRefreshEndpoint } =
      await loadEndpoints();

    expect(configuredSessionEndpoint()).toBe(
      "https://api.elizacloud.ai/api/auth/steward-session",
    );
    expect(configuredRefreshEndpoint()).toBe(
      "https://api.elizacloud.ai/api/auth/steward-refresh",
    );
  });

  it("routes the prod app host to the prod api worker directly", async () => {
    setHostname("app.elizacloud.ai");
    const { configuredSessionEndpoint, configuredRefreshEndpoint } =
      await loadEndpoints();

    expect(configuredSessionEndpoint()).toBe(
      "https://api.elizacloud.ai/api/auth/steward-session",
    );
    expect(configuredRefreshEndpoint()).toBe(
      "https://api.elizacloud.ai/api/auth/steward-refresh",
    );
  });

  it("falls back to the same-origin relative path on an unknown host", async () => {
    setHostname("localhost");
    const { configuredSessionEndpoint, configuredRefreshEndpoint } =
      await loadEndpoints();

    expect(configuredSessionEndpoint()).toBe("/api/auth/steward-session");
    expect(configuredRefreshEndpoint()).toBe("/api/auth/steward-refresh");
  });
});

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

describe("tokenIsExpired", () => {
  it("keeps a token with a future exp", () => {
    expect(
      tokenIsExpired(makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 })),
    ).toBe(false);
  });

  it("treats a past exp as expired", () => {
    expect(
      tokenIsExpired(makeJwt({ exp: Math.floor(Date.now() / 1000) - 600 })),
    ).toBe(true);
  });

  it("treats a token WITHOUT exp as expired — the 401 handlers keep any non-expired token, so an exp-less one would otherwise be uncloseable", () => {
    expect(tokenIsExpired(makeJwt({ sub: "u1" }))).toBe(true);
  });

  it("treats a token with a non-numeric exp as expired", () => {
    expect(tokenIsExpired(makeJwt({ sub: "u1", exp: "soon" }))).toBe(true);
  });

  it("treats an undecodable token as expired", () => {
    expect(tokenIsExpired("not-a-jwt")).toBe(true);
  });
});
