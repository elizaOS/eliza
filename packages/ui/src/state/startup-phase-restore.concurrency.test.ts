/** Verifies cloud restore routes the client without waiting on the Steward refresh through the package's configured test harness. */
// @vitest-environment jsdom
//
// Boot parallelization of the restoring-session phase: (1) a cloud restore
// derives a missing per-agent base synchronously from the persisted id and
// routes the client while the Steward-token refresh round-trip is still in
// flight (client mutations still land base → token), and (2) a desktop local
// restore issues ONE runtime-mode RPC shared by the agent-autostart gate and
// the embedded-local target reclassification.
// Real restore module under test; only the network / desktop-bridge
// boundaries are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../config/boot-config-store";
import type { PersistedActiveServer } from "./persistence";
import {
  clearPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import {
  applyRestoredConnection,
  type RestoringSessionDeps,
  reconcileMobileRestoredActiveServer,
  runRestoringSession,
} from "./startup-phase-restore";

const STEWARD_TOKEN_KEY = "steward_session_token";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SHARED_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const STAGING_AGENT_ID = "33333333-3333-4333-8333-333333333333";

/** Build a minimal (unsigned) JWT whose payload carries the given `exp`. */
function makeJwt(expSecondsFromNow: number): string {
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc({
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
  })}.sig`;
}

type BridgeRpcOptions = { rpcMethod?: string };
type BridgeRpcResult =
  | { status: "timeout" }
  | { status: "ok"; value: { mode?: string } };

const bridgeMock = vi.hoisted(() => ({
  getBackendStartupTimeoutMs: vi.fn(() => 180_000),
  invokeDesktopBridgeRequestWithTimeout: vi.fn(
    async (_options: { rpcMethod?: string }): Promise<BridgeRpcResult> => ({
      status: "timeout",
    }),
  ),
  isElectrobunRuntime: vi.fn(() => true),
  scanProviderCredentials: vi.fn(async () => []),
}));

const firstRunBootstrapMock = vi.hoisted(() => ({
  detectExistingFirstRunConnection: vi.fn(async () => null),
}));

vi.mock("../bridge", () => bridgeMock);
vi.mock("./first-run-bootstrap", () => firstRunBootstrapMock);

function makeDeps(): RestoringSessionDeps {
  return {
    setStartupError: vi.fn(),
    setAuthRequired: vi.fn(),
    setConnected: vi.fn(),
    setFirstRunOptions: vi.fn(),
    setFirstRunComplete: vi.fn(),
    setFirstRunLoading: vi.fn(),
    firstRunCompletionCommittedRef: { current: false },
    uiLanguage: "en",
  };
}

describe("cloud restore routes the client without waiting on the Steward refresh", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;
  const realLocation = window.location;
  const pendingRequests: Array<{
    url: string;
    resolve: (r: Response) => void;
  }> = [];

  beforeEach(() => {
    localStorage.clear();
    setBootConfig(DEFAULT_BOOT_CONFIG);
    pendingRequests.length = 0;
    fetchMock = vi.fn(
      (input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          pendingRequests.push({
            url:
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url,
            resolve,
          });
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
    setBootConfig(DEFAULT_BOOT_CONFIG);
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("clears the inherited credential before routing while Steward refresh is in flight", async () => {
    // A near-expiry stored JWT forces the refresh POST…
    const nearExpiry = makeJwt(30);
    localStorage.setItem(STEWARD_TOKEN_KEY, nearExpiry);
    const fresh = makeJwt(3600);
    // …and a MISSING apiBase forces the backfill, which derives the dedicated
    // `<agentId>.cloud.eliza.app` base purely from the persisted id.
    const restored: PersistedActiveServer = {
      id: `cloud:${AGENT_ID}`,
      kind: "cloud",
      label: "Eliza Cloud",
    };

    const clientRef = { setBaseUrl: vi.fn(), setToken: vi.fn() };
    const done = applyRestoredConnection({
      restoredActiveServer: restored,
      clientRef,
    });

    // The startup-latency contract keeps base routing outside the refresh
    // round-trip, but the selected record's known token must replace any old
    // live bearer before that base becomes observable.
    await vi.waitFor(() => {
      expect(
        pendingRequests.some((r) => r.url.includes("steward-refresh")),
      ).toBe(true);
      expect(clientRef.setBaseUrl).toHaveBeenCalledTimes(1);
    });
    // The backfill is derivation-only: the refresh POST is the sole network
    // round-trip in the whole cloud restore (no agent lookup to wait behind).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clientRef.setToken).toHaveBeenCalledTimes(2);
    expect(clientRef.setToken).toHaveBeenNthCalledWith(1, null);
    expect(clientRef.setToken).toHaveBeenLastCalledWith(nearExpiry);
    expect(clientRef.setBaseUrl).toHaveBeenLastCalledWith(
      `https://${AGENT_ID}.cloud.eliza.app`,
    );
    expect(clientRef.setToken.mock.invocationCallOrder[0]).toBeLessThan(
      clientRef.setBaseUrl.mock.invocationCallOrder[0] as number,
    );
    expect(clientRef.setBaseUrl.mock.invocationCallOrder[0]).toBeLessThan(
      clientRef.setToken.mock.invocationCallOrder[1] as number,
    );

    // Settle the refresh; the restore completes with the fresh token.
    for (const req of pendingRequests) {
      req.resolve({
        ok: true,
        status: 200,
        json: async () => ({ token: fresh }),
      } as unknown as Response);
    }
    await done;

    // Terminal state replaces the provisional credential with the refreshed
    // Steward token without re-pointing the already safe base.
    expect(clientRef.setBaseUrl).toHaveBeenCalledTimes(1);
    expect(clientRef.setToken).toHaveBeenLastCalledWith(fresh);
  });

  it("preserves a shared adapter with account authority regardless of the create default", async () => {
    const stewardToken = makeJwt(3600);
    localStorage.setItem(STEWARD_TOKEN_KEY, stewardToken);
    const sharedApiBase = `https://api.eliza.app/api/v1/eliza/agents/${SHARED_AGENT_ID}`;
    const restored: PersistedActiveServer = {
      id: `cloud:${SHARED_AGENT_ID}`,
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: sharedApiBase,
      accessToken: "paired-token",
    };

    const dedicatedClient = { setBaseUrl: vi.fn(), setToken: vi.fn() };
    await applyRestoredConnection({
      restoredActiveServer: restored,
      clientRef: dedicatedClient,
    });
    expect(dedicatedClient.setBaseUrl).toHaveBeenCalledWith(sharedApiBase);
    expect(dedicatedClient.setToken).toHaveBeenLastCalledWith(stewardToken);

    setBootConfig({ ...DEFAULT_BOOT_CONFIG, preferSharedCloudTier: true });
    const sharedClient = { setBaseUrl: vi.fn(), setToken: vi.fn() };
    await applyRestoredConnection({
      restoredActiveServer: restored,
      clientRef: sharedClient,
    });
    expect(sharedClient.setBaseUrl).toHaveBeenCalledWith(sharedApiBase);
    expect(sharedClient.setToken).toHaveBeenLastCalledWith(stewardToken);
  });

  it("canonicalizes a legacy staging shared adapter on the staging control plane", async () => {
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      cloudApiBase: "https://staging.elizacloud.ai",
    });
    const stewardToken = makeJwt(3600);
    localStorage.setItem(STEWARD_TOKEN_KEY, stewardToken);
    const restored: PersistedActiveServer = {
      id: `cloud:${STAGING_AGENT_ID}`,
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: `https://api-staging.elizacloud.ai/api/v1/eliza/agents/${STAGING_AGENT_ID}`,
      accessToken: "paired-token",
    };
    const clientRef = { setBaseUrl: vi.fn(), setToken: vi.fn() };

    await applyRestoredConnection({
      restoredActiveServer: restored,
      clientRef,
    });

    expect(clientRef.setBaseUrl).toHaveBeenCalledWith(
      `https://api-staging.eliza.app/api/v1/eliza/agents/${STAGING_AGENT_ID}`,
    );
    expect(clientRef.setToken).toHaveBeenLastCalledWith(stewardToken);
  });

  it("repairs a legacy dedicated-looking staging base when the owner record is shared", async () => {
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      cloudApiBase: "https://staging.elizacloud.ai",
    });
    const stewardToken = makeJwt(3600);
    localStorage.setItem(STEWARD_TOKEN_KEY, stewardToken);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { executionTier: "shared" },
      }),
    } as Response);
    const clientRef = { setBaseUrl: vi.fn(), setToken: vi.fn() };

    await applyRestoredConnection({
      restoredActiveServer: {
        id: `cloud:${SHARED_AGENT_ID}`,
        kind: "cloud",
        label: "Eliza Cloud",
        apiBase: `https://${SHARED_AGENT_ID}.elizacloud.ai`,
      },
      clientRef,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api-staging.eliza.app/api/v1/eliza/agents/${SHARED_AGENT_ID}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${stewardToken}`,
        }),
      }),
    );
    await vi.waitFor(() => {
      expect(clientRef.setBaseUrl).toHaveBeenLastCalledWith(
        `https://api-staging.eliza.app/api/v1/eliza/agents/${SHARED_AGENT_ID}`,
      );
      expect(clientRef.setToken).toHaveBeenLastCalledWith(stewardToken);
    });
    expect(clientRef.setToken).toHaveBeenCalledWith(stewardToken);
  });

  it("uses the refreshed Steward token for legacy tier repair", async () => {
    bridgeMock.isElectrobunRuntime.mockReturnValue(false);
    const expired = makeJwt(-60);
    const fresh = makeJwt(3600);
    localStorage.setItem(STEWARD_TOKEN_KEY, expired);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("steward-refresh")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: fresh }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { executionTier: "shared" },
        }),
      } as Response;
    });
    const clientRef = { setBaseUrl: vi.fn(), setToken: vi.fn() };

    await applyRestoredConnection({
      restoredActiveServer: {
        id: `cloud:${SHARED_AGENT_ID}`,
        kind: "cloud",
        label: "Eliza Cloud",
        apiBase: `https://${SHARED_AGENT_ID}.elizacloud.ai`,
      },
      clientRef,
    });

    await vi.waitFor(() => {
      expect(clientRef.setBaseUrl).toHaveBeenLastCalledWith(
        `https://api.eliza.app/api/v1/eliza/agents/${SHARED_AGENT_ID}`,
      );
    });
    const tierLookup = fetchMock.mock.calls.find(([input]) =>
      String(input).includes(`/api/v1/eliza/agents/${SHARED_AGENT_ID}`),
    );
    expect(tierLookup?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${fresh}`,
        }),
      }),
    );
    expect(tierLookup?.[1]).not.toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${expired}`,
        }),
      }),
    );
    expect(clientRef.setToken).toHaveBeenLastCalledWith(fresh);
  });

  it("keeps the native owner key through tier repair when Steward refresh fails", async () => {
    bridgeMock.isElectrobunRuntime.mockReturnValue(true);
    const nearExpiry = makeJwt(30);
    const nativeOwnerKey = "eliza_native-owner-key";
    localStorage.setItem(STEWARD_TOKEN_KEY, nearExpiry);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("steward-refresh")) {
        return {
          ok: false,
          status: 401,
          json: async () => ({}),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { executionTier: "shared" },
        }),
      } as Response;
    });
    const clientRef = { setBaseUrl: vi.fn(), setToken: vi.fn() };

    await applyRestoredConnection({
      restoredActiveServer: {
        id: `cloud:${SHARED_AGENT_ID}`,
        kind: "cloud",
        label: "Eliza Cloud",
        apiBase: `https://${SHARED_AGENT_ID}.elizacloud.ai`,
        accessToken: nativeOwnerKey,
      },
      clientRef,
    });

    await vi.waitFor(() => {
      expect(clientRef.setBaseUrl).toHaveBeenLastCalledWith(
        `https://api.eliza.app/api/v1/eliza/agents/${SHARED_AGENT_ID}`,
      );
    });
    const tierLookup = fetchMock.mock.calls.find(([input]) =>
      String(input).includes(`/api/v1/eliza/agents/${SHARED_AGENT_ID}`),
    );
    expect(tierLookup?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${nativeOwnerKey}`,
        }),
      }),
    );
    expect(clientRef.setToken).toHaveBeenLastCalledWith(nativeOwnerKey);
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("repairs a previously persisted production ingress in the staging app", async () => {
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      cloudApiBase: "https://staging.elizacloud.ai",
    });
    const restored: PersistedActiveServer = {
      id: `cloud:${STAGING_AGENT_ID}`,
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: `https://${STAGING_AGENT_ID}.elizacloud.ai`,
      accessToken: "paired-token",
    };
    const clientRef = { setBaseUrl: vi.fn(), setToken: vi.fn() };

    await applyRestoredConnection({
      restoredActiveServer: restored,
      clientRef,
    });

    expect(clientRef.setBaseUrl).toHaveBeenCalledWith(
      `https://${STAGING_AGENT_ID}.cloud-staging.eliza.app`,
    );
    expect(clientRef.setToken).toHaveBeenCalledWith("paired-token");
  });

  it("keeps staging dedicated ingress when the page is staging but boot defaults to prod", async () => {
    // Regression: agent-subdomain bundles ship cloudApiBase=https://elizacloud.ai.
    // Restore must not rewrite *.staging.elizacloud.ai onto production.
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      cloudApiBase: "https://elizacloud.ai",
    });
    const stagingOrigin = `https://${STAGING_AGENT_ID}.staging.elizacloud.ai`;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL(`${stagingOrigin}/`),
    });
    const restored: PersistedActiveServer = {
      id: `cloud:${STAGING_AGENT_ID}`,
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: stagingOrigin,
      accessToken: "paired-token",
    };
    const clientRef = { setBaseUrl: vi.fn(), setToken: vi.fn() };

    await applyRestoredConnection({
      restoredActiveServer: restored,
      clientRef,
    });

    expect(clientRef.setBaseUrl).toHaveBeenCalledWith(stagingOrigin);
    expect(clientRef.setToken).toHaveBeenCalledWith("paired-token");
  });

  it("canonicalizes a legacy staging dedicated base under the prod boot default", async () => {
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      cloudApiBase: "https://elizacloud.ai",
    });
    const stagingOrigin = `https://${STAGING_AGENT_ID}.staging.elizacloud.ai`;
    const restored: PersistedActiveServer = {
      id: `cloud:${STAGING_AGENT_ID}`,
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: stagingOrigin,
      accessToken: "paired-token",
    };
    const clientRef = { setBaseUrl: vi.fn(), setToken: vi.fn() };

    await applyRestoredConnection({
      restoredActiveServer: restored,
      clientRef,
    });

    expect(clientRef.setBaseUrl).toHaveBeenCalledWith(
      `https://${STAGING_AGENT_ID}.cloud-staging.eliza.app`,
    );
    expect(clientRef.setToken).toHaveBeenCalledWith("paired-token");
  });
});

describe("desktop local restore shares one runtime-mode RPC", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    clearPersistedActiveServer();
    vi.clearAllMocks();
    bridgeMock.isElectrobunRuntime.mockReturnValue(true);
    bridgeMock.invokeDesktopBridgeRequestWithTimeout.mockResolvedValue({
      status: "timeout",
    });
    // The restore now primes /api/auth/me fire-and-forget; keep the test
    // hermetic (a 503 prime is discarded by design, so it is inert here).
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 503,
          json: async () => ({}),
        }) as unknown as Response,
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
  });

  function rpcCallCount(rpcMethod: string): number {
    return bridgeMock.invokeDesktopBridgeRequestWithTimeout.mock.calls.filter(
      (call) =>
        (call[0] as BridgeRpcOptions | undefined)?.rpcMethod === rpcMethod,
    ).length;
  }
  const modeCalls = () => rpcCallCount("desktopGetRuntimeMode");
  const agentStartCalls = () => rpcCallCount("agentStart");

  it("issues exactly one desktopGetRuntimeMode RPC for autostart gate + target resolution", async () => {
    savePersistedActiveServer({
      id: "local",
      kind: "local",
      label: "Local Agent",
    });
    const dispatch = vi.fn();

    await runRestoringSession(
      makeDeps(),
      dispatch,
      { current: null },
      {
        current: false,
      },
    );

    expect(modeCalls()).toBe(1);
    // Timeout ⇒ mode unknown ⇒ the autostart still fires (unchanged gate).
    expect(agentStartCalls()).toBe(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "SESSION_RESTORED",
      target: "embedded-local",
    });
  });

  it("keeps the semantics: non-local mode skips agent start AND reclassifies to remote-backend", async () => {
    savePersistedActiveServer({
      id: "local",
      kind: "local",
      label: "Local Agent",
    });
    bridgeMock.invokeDesktopBridgeRequestWithTimeout.mockImplementation(
      async (options: BridgeRpcOptions): Promise<BridgeRpcResult> => {
        if (options.rpcMethod === "desktopGetRuntimeMode") {
          return { status: "ok", value: { mode: "external" } };
        }
        return { status: "timeout" };
      },
    );
    const dispatch = vi.fn();

    await runRestoringSession(
      makeDeps(),
      dispatch,
      { current: null },
      {
        current: false,
      },
    );

    expect(modeCalls()).toBe(1);
    expect(agentStartCalls()).toBe(0);
    expect(dispatch).toHaveBeenCalledWith({
      type: "SESSION_RESTORED",
      target: "remote-backend",
    });
  });
});

describe("mobile restored target reconciliation", () => {
  it("drops a persisted local target after switching away from local mode", () => {
    expect(
      reconcileMobileRestoredActiveServer({
        server: { id: "local", kind: "local", label: "Local Agent" },
        mobileRuntimeMode: "cloud",
        platform: "android",
      }),
    ).toBeNull();
  });

  it("normalizes a legacy local target to the active platform IPC base", () => {
    expect(
      reconcileMobileRestoredActiveServer({
        server: { id: "local", kind: "local", label: "Local Agent" },
        mobileRuntimeMode: "local",
        platform: "android",
      }),
    ).toMatchObject({
      id: "local:android",
      apiBase: "eliza-local-agent://ipc",
    });
  });
});
