/** Verifies Steward auth endpoint resolution through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Steward auth-endpoint resolution and token-expiry helpers: staging/prod UI
 * hosts route through their same-origin proxy so host-only cookies remain visible, unknown hosts
 * fall back to the same-origin relative path, and `tokenIsExpired` reads the
 * JWT `exp` claim.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenIsExpired } from "./StewardProviderShared";

// The Steward auth endpoints are resolved per browser host: co-hosted cloud
// surfaces use their same-origin Pages/Worker proxy. The invariant under guard:
// staging and production never cross environments, even when a build-time API
// base is present; otherwise host-only cookies land on the API hostname and the
// SSO bridge cannot observe the browser session.

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
  it("keeps canonical staging session cookies on the staging marketing host", async () => {
    setHostname("staging.eliza.app");
    const { configuredSessionEndpoint, configuredRefreshEndpoint } =
      await loadEndpoints();

    expect(configuredSessionEndpoint()).toBe(
      "https://staging.eliza.app/api/auth/steward-session",
    );
    expect(configuredRefreshEndpoint()).toBe(
      "https://staging.eliza.app/api/auth/steward-refresh",
    );
  });

  it("keeps canonical staging session cookies on the managed app host", async () => {
    setHostname("cloud-staging.eliza.app");
    const { configuredSessionEndpoint, configuredRefreshEndpoint } =
      await loadEndpoints();

    expect(configuredSessionEndpoint()).toBe(
      "https://cloud-staging.eliza.app/api/auth/steward-session",
    );
    expect(configuredRefreshEndpoint()).toBe(
      "https://cloud-staging.eliza.app/api/auth/steward-refresh",
    );
  });

  it("keeps canonical production session cookies on eliza.app", async () => {
    setHostname("eliza.app");
    const { configuredSessionEndpoint, configuredRefreshEndpoint } =
      await loadEndpoints();

    expect(configuredSessionEndpoint()).toBe(
      "https://eliza.app/api/auth/steward-session",
    );
    expect(configuredRefreshEndpoint()).toBe(
      "https://eliza.app/api/auth/steward-refresh",
    );
  });

  it("keeps canonical production session cookies on cloud.eliza.app", async () => {
    setHostname("cloud.eliza.app");
    const { configuredSessionEndpoint, configuredRefreshEndpoint } =
      await loadEndpoints();

    expect(configuredSessionEndpoint()).toBe(
      "https://cloud.eliza.app/api/auth/steward-session",
    );
    expect(configuredRefreshEndpoint()).toBe(
      "https://cloud.eliza.app/api/auth/steward-refresh",
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
