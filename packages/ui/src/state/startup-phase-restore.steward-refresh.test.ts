// @vitest-environment jsdom
//
// #10231 launch-blocker #4 — a returning cloud user whose stored Steward JWT
// expired while the app was closed must NOT boot into a permanently-401ing
// session. `applyRestoredConnection`'s cloud branch refreshes an expired /
// near-expiry stored JWT BEFORE handing it to the client, so the first authed
// call carries a live token (or, if the refresh fails, the session restores
// unauthenticated rather than dialing with a known-dead credential).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedActiveServer } from "./persistence";
import { applyRestoredConnection } from "./startup-phase-restore";

const STEWARD_TOKEN_KEY = "steward_session_token";
const STEWARD_REFRESH_PATH = "/api/auth/steward-refresh";

/** Build a minimal (unsigned) JWT whose payload carries the given `exp`. */
function makeJwt(expSecondsFromNow: number | null): string {
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const header = enc({ alg: "none", typ: "JWT" });
  const payload = enc(
    expSecondsFromNow === null
      ? {}
      : { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow },
  );
  return `${header}.${payload}.sig`;
}

/** A cloud active-server with a concrete (non-agentless) apiBase so the restore
 * backfill returns immediately without any network round-trip. */
function cloudServer(
  overrides: Partial<PersistedActiveServer> = {},
): PersistedActiveServer {
  return {
    id: "cloud:agent-123",
    kind: "cloud",
    label: "Eliza Cloud",
    apiBase: "https://agent-123.example.com",
    ...overrides,
  };
}

function fakeClient() {
  return { setBaseUrl: vi.fn(), setToken: vi.fn() };
}

describe("applyRestoredConnection — cloud Steward token refresh at restore", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("refreshes an EXPIRED stored JWT before setting it, and sets the refreshed token", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
    const fresh = makeJwt(3600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });

    const client = fakeClient();
    await applyRestoredConnection({
      restoredActiveServer: cloudServer(),
      clientRef: client,
    });

    // A single refresh POST to the same-origin endpoint (web / jsdom).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(STEWARD_REFRESH_PATH);
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    // The client receives the REFRESHED token, not the expired one.
    expect(client.setToken).toHaveBeenCalledWith(fresh);
    // The fresh token is mirrored back to localStorage.
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(fresh);
  });

  it("refreshes a NEAR-EXPIRY stored JWT (inside the refresh-ahead margin)", async () => {
    // 30s of life left is under the 120s refresh-ahead margin.
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(30));
    const fresh = makeJwt(3600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });

    const client = fakeClient();
    await applyRestoredConnection({
      restoredActiveServer: cloudServer(),
      clientRef: client,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.setToken).toHaveBeenCalledWith(fresh);
  });

  it("does NOT refresh a comfortably-valid stored JWT (instant restore)", async () => {
    const valid = makeJwt(3600);
    localStorage.setItem(STEWARD_TOKEN_KEY, valid);

    const client = fakeClient();
    await applyRestoredConnection({
      restoredActiveServer: cloudServer(),
      clientRef: client,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.setBaseUrl).toHaveBeenCalledWith(
      "https://agent-123.example.com",
    );
    expect(client.setToken).toHaveBeenCalledWith(valid);
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(valid);
  });

  it("does NOT refresh an opaque (non-JWT) token; uses it as-is", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "opaque-device-code-token");

    const client = fakeClient();
    await applyRestoredConnection({
      restoredActiveServer: cloudServer(),
      clientRef: client,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.setToken).toHaveBeenCalledWith("opaque-device-code-token");
  });

  it("leaves the session UNAUTHENTICATED (and clears the token) when refresh fails, without looping", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });

    const client = fakeClient();
    await applyRestoredConnection({
      // No provision-time accessToken to fall back to.
      restoredActiveServer: cloudServer({ accessToken: undefined }),
      clientRef: client,
    });

    // Exactly one refresh attempt — no retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The dead credential is dropped and the client is left unauthenticated.
    expect(client.setToken).toHaveBeenCalledWith(null);
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("falls back to the provision-time token when refresh fails but the JWT is still (barely) alive", async () => {
    // 30s left → attempts refresh, but the token is not yet expired, so a
    // failed refresh keeps it rather than dropping to unauthenticated.
    const nearExpiry = makeJwt(30);
    localStorage.setItem(STEWARD_TOKEN_KEY, nearExpiry);
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });

    const client = fakeClient();
    await applyRestoredConnection({
      restoredActiveServer: cloudServer(),
      clientRef: client,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.setToken).toHaveBeenCalledWith(nearExpiry);
    // Still-alive token is retained for the useCloudState lifecycle refresh.
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(nearExpiry);
  });
});
