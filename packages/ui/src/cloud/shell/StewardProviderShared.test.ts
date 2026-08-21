/** Verifies Steward auth endpoint resolution through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Steward auth-endpoint resolution and token-expiry helpers: staging/prod UI
 * hosts route through their same-origin proxy so host-only cookies remain visible, unknown hosts
 * fall back to the same-origin relative path, and `tokenIsExpired` reads the
 * JWT `exp` claim.
 */

import {
  registerStewardTokenRemoval,
  STEWARD_REFRESH_TOKEN_KEY,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadAgentProfileRegistry,
  saveAgentProfileRegistry,
} from "../../state/agent-profiles";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../../state/persistence";

import {
  clearStaleStewardSession,
  tokenIsExpired,
} from "./StewardProviderShared";

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

describe("clearStaleStewardSession", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("drops a shared Cloud agent selection so the next account resolves its own agent", async () => {
    savePersistedActiveServer({
      id: "cloud:old-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://api.eliza.app/api/v1/eliza/agents/old-agent",
      accessToken: "expired-steward-token",
    });

    await clearStaleStewardSession();

    expect(loadPersistedActiveServer()).toBeNull();
  });

  it("preserves a dedicated target selection while scrubbing its rejected bearer", async () => {
    savePersistedActiveServer({
      id: "cloud:dedicated-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://dedicated-agent.eliza.app",
      accessToken: "rejected-agent-token",
    });

    await clearStaleStewardSession();

    expect(loadPersistedActiveServer()).toEqual({
      id: "cloud:dedicated-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://dedicated-agent.eliza.app",
    });
  });

  it("finishes credential teardown before rethrowing obsolete refresh-key cleanup failure", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "expired-steward-token");
    localStorage.setItem(STEWARD_REFRESH_TOKEN_KEY, "obsolete-refresh-token");
    savePersistedActiveServer({
      id: "cloud:dedicated-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://dedicated-agent.eliza.app",
      accessToken: "active-server-mirror",
    });
    saveAgentProfileRegistry({
      version: 1,
      activeProfileId: "profile-1",
      profiles: [
        {
          id: "profile-1",
          label: "Remote agent",
          kind: "remote",
          apiBase: "https://remote.example.test",
          accessToken: "profile-mirror",
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      ],
    });
    const storageFailure = new Error("legacy refresh storage unavailable");
    const storage = window.localStorage;
    const originalRemoveItem = storage.removeItem.bind(storage);
    // jsdom implements Storage methods on the prototype, while the Node ≥25
    // fallback in vitest.setup owns them directly. Spy on the actual method
    // owner so this regression injects the same failure on every supported
    // test host instead of passing only with one storage implementation.
    const removeItemOwner = Object.hasOwn(storage, "removeItem")
      ? storage
      : (Object.getPrototypeOf(storage) as Storage);
    const removeItem = vi
      .spyOn(removeItemOwner, "removeItem")
      .mockImplementation((key: string) => {
        if (key === STEWARD_REFRESH_TOKEN_KEY) throw storageFailure;
        return originalRemoveItem(key);
      });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    try {
      await expect(clearStaleStewardSession()).rejects.toThrow(storageFailure);
    } finally {
      removeItem.mockRestore();
    }

    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(loadPersistedActiveServer()?.accessToken).toBeUndefined();
    expect(loadAgentProfileRegistry().profiles[0]?.accessToken).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "DELETE", credentials: "include" }),
    );
  });

  it("retains logical account state when canonical protected removal fails", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "still-durable-token");
    savePersistedActiveServer({
      id: "cloud:old-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://api.eliza.app/api/v1/eliza/agents/old-agent",
      accessToken: "still-durable-token",
    });
    const deletionFailure = new Error("native secure deletion denied");
    const unregister = registerStewardTokenRemoval(async () => {
      throw deletionFailure;
    });

    try {
      await expect(clearStaleStewardSession()).rejects.toMatchObject({
        name: "StewardTokenRemovalError",
        message: deletionFailure.message,
        cause: deletionFailure,
      });
    } finally {
      unregister();
    }

    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("still-durable-token");
    expect(loadPersistedActiveServer()?.accessToken).toBe(
      "still-durable-token",
    );
  });
});

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
