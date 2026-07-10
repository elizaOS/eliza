// @vitest-environment jsdom
//
// Boot parallelization of the restoring-session phase: (1) a cloud restore
// derives the dedicated per-agent base synchronously from the persisted id —
// no backfill network lookup — and routes the client while the Steward-token
// refresh round-trip is still in flight (client mutations still land base →
// token), and (2) a desktop local restore issues ONE runtime-mode RPC shared
// by the agent-autostart gate and the embedded-local target reclassification.
// Real restore module under test; only the network / desktop-bridge
// boundaries are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingCloudHandoff,
  savePendingCloudHandoff,
} from "../cloud/handoff/pending-handoff-store";
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
    clearPendingCloudHandoff();
    setBootConfig(DEFAULT_BOOT_CONFIG);
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("sets the id-derived dedicated base while the Steward refresh is still in flight", async () => {
    // A near-expiry stored JWT forces the refresh POST…
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(30));
    const fresh = makeJwt(3600);
    // …and a MISSING apiBase forces the backfill, which derives the dedicated
    // `<agentId>.elizacloud.ai` base purely from the persisted id.
    const restored: PersistedActiveServer = {
      id: "cloud:agent-123",
      kind: "cloud",
      label: "Eliza Cloud",
    };

    const clientRef = { setBaseUrl: vi.fn(), setToken: vi.fn() };
    const done = applyRestoredConnection({
      restoredActiveServer: restored,
      clientRef,
    });

    // The startup-latency contract: while the refresh POST is observable and
    // UNRESOLVED, the client base must already be routed — base routing is
    // never serialized behind the refresh round-trip.
    await vi.waitFor(() => {
      expect(
        pendingRequests.some((r) => r.url.includes("steward-refresh")),
      ).toBe(true);
      expect(clientRef.setBaseUrl).toHaveBeenCalledTimes(1);
    });
    // The backfill is derivation-only: the refresh POST is the sole network
    // round-trip in the whole cloud restore (no agent lookup to wait behind).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clientRef.setBaseUrl).toHaveBeenLastCalledWith(
      "https://agent-123.elizacloud.ai",
    );
    // Token routing DOES wait for the refresh (fresh credential or nothing).
    expect(clientRef.setToken).not.toHaveBeenCalled();

    // Settle the refresh; the restore completes with the fresh token.
    for (const req of pendingRequests) {
      req.resolve({
        ok: true,
        status: 200,
        json: async () => ({ token: fresh }),
      } as unknown as Response);
    }
    await done;

    // Same terminal state as the serial code: id-derived per-agent base,
    // refreshed Steward token, base set before token.
    expect(clientRef.setBaseUrl).toHaveBeenCalledTimes(1);
    expect(clientRef.setToken).toHaveBeenLastCalledWith(fresh);
    expect(clientRef.setBaseUrl.mock.invocationCallOrder[0]).toBeLessThan(
      clientRef.setToken.mock.invocationCallOrder.at(-1) as number,
    );
  });

  it("repairs a pending shared adapter unless the host explicitly enables shared tier", async () => {
    const sharedApiBase =
      "https://api.elizacloud.ai/api/v1/eliza/agents/shared-agent";
    savePendingCloudHandoff({
      sharedAgentId: "shared-agent",
      dedicatedAgentId: "dedicated-agent",
      sharedApiBase,
      cloudApiBase: "https://elizacloud.ai",
      startedAt: Date.now(),
    });
    const restored: PersistedActiveServer = {
      id: "cloud:shared-agent",
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
    expect(dedicatedClient.setBaseUrl).toHaveBeenCalledWith(
      "https://shared-agent.elizacloud.ai",
    );
    expect(dedicatedClient.setToken).toHaveBeenCalledWith("paired-token");

    setBootConfig({ ...DEFAULT_BOOT_CONFIG, preferSharedCloudTier: true });
    const sharedClient = { setBaseUrl: vi.fn(), setToken: vi.fn() };
    await applyRestoredConnection({
      restoredActiveServer: restored,
      clientRef: sharedClient,
    });
    expect(sharedClient.setBaseUrl).toHaveBeenCalledWith(sharedApiBase);
    expect(sharedClient.setToken).toHaveBeenCalledWith("paired-token");
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
