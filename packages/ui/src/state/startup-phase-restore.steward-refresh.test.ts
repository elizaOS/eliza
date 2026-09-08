/**
 * Exercises Cloud session restoration with real jsdom storage and a bounded
 * fetch double. Steward JWT refresh and agent-local loopback credentials stay
 * isolated so neither credential is sent to the wrong trust boundary.
 */
// @vitest-environment jsdom

import {
  registerStewardTokenPersistence,
  STEWARD_LOGOUT_GENERATION_KEY,
} from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPersistedActiveServer,
  type PersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import { applyRestoredConnection } from "./startup-phase-restore";

const STEWARD_TOKEN_KEY = "steward_session_token";
const STEWARD_REFRESH_PATH = "/api/auth/steward-refresh";
const CLOUD_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CLOUD_AGENT_API_BASE = `https://api.eliza.app/api/v1/eliza/agents/${CLOUD_AGENT_ID}`;

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
    id: `cloud:${CLOUD_AGENT_ID}`,
    kind: "cloud",
    label: "Eliza Cloud",
    apiBase: CLOUD_AGENT_API_BASE,
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

  it("does not publish a restore token when the selected agent changes during persistence", async () => {
    const previous = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, previous);
    savePersistedActiveServer(cloudServer());
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const publish = vi.fn();
    const unregister = registerStewardTokenPersistence(
      async (token, validate, scope) => {
        entered = true;
        await held;
        validate();
        scope.commit(() => {
          publish();
          localStorage.setItem(STEWARD_TOKEN_KEY, token);
        });
      },
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: makeJwt(3600) }),
    });
    const client = fakeClient();
    const result = applyRestoredConnection({
      restoredActiveServer: cloudServer(),
      clientRef: client,
    }).then(
      () => "completed",
      (error: Error) => error.name,
    );
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      const selected = cloudServer({
        id: "cloud:new",
        apiBase:
          "https://api.eliza.app/api/v1/eliza/agents/22222222-2222-4222-8222-222222222222",
      });
      savePersistedActiveServer(selected);
      release();
      expect(await result).not.toBe("completed");
      expect(publish).not.toHaveBeenCalled();
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(previous);
      expect(loadPersistedActiveServer()).toEqual(selected);
    } finally {
      release();
      await result;
      unregister();
    }
  });

  it("does not publish a restored session after its startup lifetime is cancelled", async () => {
    const previous = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, previous);
    let release!: (response: object) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const client = fakeClient();
    const result = applyRestoredConnection({
      restoredActiveServer: cloudServer(),
      clientRef: client,
      signal: controller.signal,
    }).then(
      () => "completed",
      (error: Error) => error.name,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    client.setToken.mockClear();
    release({
      ok: true,
      status: 200,
      json: async () => ({ token: makeJwt(3600) }),
    });
    await result;
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(previous);
    expect(client.setToken).not.toHaveBeenCalled();
  });

  it.each(["success", "rejected"])(
    "does not overwrite or clear a newer session after a late %s response",
    async (outcome) => {
      localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
      let release!: (response: object) => void;
      fetchMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const client = fakeClient();
      const result = applyRestoredConnection({
        restoredActiveServer: cloudServer(),
        clientRef: client,
      }).then(
        () => "completed",
        (error: Error) => error.name,
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const newer = makeJwt(7200);
      localStorage.setItem(STEWARD_LOGOUT_GENERATION_KEY, "1:external-logout");
      localStorage.setItem(STEWARD_TOKEN_KEY, newer);
      savePersistedActiveServer(
        cloudServer({ id: "cloud:new-selection", accessToken: newer }),
      );
      client.setToken.mockClear();
      client.setBaseUrl.mockClear();
      release({
        ok: outcome === "success",
        status: outcome === "success" ? 200 : 401,
        json: async () => ({ token: makeJwt(3600) }),
      });
      await result;
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(newer);
      expect(loadPersistedActiveServer()?.id).toBe("cloud:new-selection");
      expect(client.setToken).not.toHaveBeenCalled();
      expect(client.setBaseUrl).not.toHaveBeenCalled();
    },
  );

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
    expect(client.setBaseUrl).toHaveBeenCalledWith(CLOUD_AGENT_API_BASE);
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

  it("keeps a local-Docker paired bearer ahead of the Cloud Steward session", async () => {
    const steward = makeJwt(3600);
    localStorage.setItem(STEWARD_TOKEN_KEY, steward);
    const client = fakeClient();

    await applyRestoredConnection({
      restoredActiveServer: cloudServer({
        apiBase: "http://127.0.0.1:43123",
        accessToken: "paired-agent-token",
      }),
      clientRef: client,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.setBaseUrl).toHaveBeenCalledWith("http://127.0.0.1:43123");
    expect(client.setToken).toHaveBeenCalledWith("paired-agent-token");
  });

  it("never sends a Steward session to a tokenless loopback target", async () => {
    const steward = makeJwt(3600);
    localStorage.setItem(STEWARD_TOKEN_KEY, steward);
    const client = fakeClient();

    await applyRestoredConnection({
      restoredActiveServer: cloudServer({
        apiBase: "http://localhost:43123",
        accessToken: undefined,
      }),
      clientRef: client,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.setBaseUrl).toHaveBeenCalledWith("http://localhost:43123");
    expect(client.setToken).toHaveBeenCalledWith(null);
    expect(client.setToken).not.toHaveBeenCalledWith(steward);
  });

  it("leaves the session UNAUTHENTICATED and drops the shared selection when refresh fails", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
    savePersistedActiveServer(
      cloudServer({ accessToken: "expired-steward-token" }),
    );
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });

    const client = fakeClient();
    await applyRestoredConnection({
      // A normal persisted record mirrors the now-expired Steward bearer.
      restoredActiveServer: cloudServer({
        accessToken: "expired-steward-token",
      }),
      clientRef: client,
    });

    // Exactly one refresh attempt — no retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The dead credential is dropped and the client is left unauthenticated.
    expect(client.setToken).toHaveBeenLastCalledWith(null);
    expect(client.setBaseUrl).toHaveBeenLastCalledWith(null);
    expect(client.setToken).not.toHaveBeenLastCalledWith(
      "expired-steward-token",
    );
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(loadPersistedActiveServer()).toBeNull();
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
