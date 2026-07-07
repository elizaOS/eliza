/**
 * Unit coverage for the startup polling backend: recoverable-base detection and
 * loopback-origin fallback. Deps injected, no live network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstRunOptions } from "../api";
import { ANDROID_LOCAL_AGENT_IPC_BASE } from "../first-run/mobile-runtime-mode";
import { clearPersistedActiveServer } from "./persistence";
import {
  isRecoverableRemoteBase,
  type PollingBackendDeps,
  runPollingBackend,
  shouldFallBackToLocalOrigin,
} from "./startup-phase-poll";
import type { RestoringSessionCtx } from "./startup-phase-restore";

const clientMock = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  getFirstRunStatus: vi.fn(),
  getFirstRunOptions: vi.fn(),
  getConfig: vi.fn(),
  getCloudCompatAgent: vi.fn(),
  hasToken: vi.fn(),
  getBaseUrl: vi.fn(() => ""),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
}));

const cloudMock = vi.hoisted(() => ({
  getCloudAuthToken: vi.fn(() => null as string | null),
}));

const androidBootStateMock = vi.hoisted(() => ({
  getAndroidLocalAgentBootStateForUrl: vi.fn(
    async (): Promise<{
      state: "unknown" | "booting" | "dead" | "listening" | "restarting";
      reason?: string;
      ageMs?: number;
    }> => ({
      state: "unknown",
    }),
  ),
  requestAndroidLocalAgentStartForUrl: vi.fn(
    async (_url: string | null | undefined) => false,
  ),
}));

vi.mock("../api", () => ({
  client: clientMock,
}));

vi.mock("../api/android-native-agent-transport", () => ({
  getAndroidLocalAgentBootStateForUrl:
    androidBootStateMock.getAndroidLocalAgentBootStateForUrl,
  requestAndroidLocalAgentStartForUrl:
    androidBootStateMock.requestAndroidLocalAgentStartForUrl,
}));

vi.mock("../api/client-cloud", () => ({
  getCloudAuthToken: cloudMock.getCloudAuthToken,
  // isDirectCloudSharedAgentBase is also imported by the module under test.
  isDirectCloudSharedAgentBase: (url: string | null | undefined) =>
    !!url &&
    /\/api\/v1\/eliza\/agents\/[^/]+(?:\/bridge)?\/?$/.test(url.trim()),
}));

vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  isAndroid: false,
  isIOS: false,
}));

vi.mock("./persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./persistence")>()),
  clearPersistedActiveServer: vi.fn(),
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return {
    ...actual,
    getBackendStartupTimeoutMs: () => 1000,
  };
});

vi.mock("@elizaos/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/shared")>();
  return {
    ...actual,
    getStylePresets: () => [],
  };
});

function firstRunOptions(): FirstRunOptions {
  return {
    names: [],
    styles: [],
    providers: [],
    cloudProviders: [],
    models: {
      nano: [],
      small: [],
      medium: [],
      large: [],
      mega: [],
    },
    inventoryProviders: [],
    sharedStyleRules: "",
  };
}

function createDeps(): PollingBackendDeps {
  return {
    setStartupError: vi.fn(),
    setAuthRequired: vi.fn(),
    setFirstRunComplete: vi.fn(),
    setFirstRunLoading: vi.fn(),
    setFirstRunOptions: vi.fn(),
    setFirstRunRuntimeTarget: vi.fn(),
    setFirstRunProvider: vi.fn(),
    setFirstRunRemoteConnected: vi.fn(),
    setFirstRunRemoteApiBase: vi.fn(),
    setFirstRunRemoteToken: vi.fn(),
    setFirstRunCloudProvisionedContainer: vi.fn(),
    setPairingEnabled: vi.fn(),
    setPairingExpiresAt: vi.fn(),
    firstRunCompletionCommittedRef: { current: false },
    uiLanguage: "en",
  };
}

const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  vi.resetAllMocks();
  clientMock.getAuthStatus.mockResolvedValue({
    required: false,
    pairingEnabled: false,
    expiresAt: null,
  });
  clientMock.getFirstRunStatus.mockResolvedValue({
    complete: false,
    cloudProvisioned: false,
  });
  clientMock.getFirstRunOptions.mockResolvedValue(firstRunOptions());
  clientMock.getConfig.mockResolvedValue({});
  clientMock.getCloudCompatAgent.mockResolvedValue({
    success: true,
    data: { agent_id: "agent-123" },
  });
  clientMock.hasToken.mockReturnValue(false);
  clientMock.getBaseUrl.mockReturnValue("");
  androidBootStateMock.getAndroidLocalAgentBootStateForUrl.mockResolvedValue({
    state: "unknown",
  });
  androidBootStateMock.requestAndroidLocalAgentStartForUrl.mockResolvedValue(
    false,
  );
  cloudMock.getCloudAuthToken.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("runPollingBackend", () => {
  it("does not let stale persisted first-run completion override an incomplete backend", async () => {
    const deps = createDeps();
    const dispatch = vi.fn();
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: null,
      restoredActiveServer: {
        id: "local:desktop",
        kind: "local",
        label: "Local agent",
        apiBase: "http://127.0.0.1:34137",
      },
      shouldPreserveCompletedFirstRun: true,
      hadPriorFirstRun: true,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(deps.setFirstRunComplete).toHaveBeenCalledWith(false);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
  });

  it("recovers by falling back to the local origin when the saved remote server is unreachable", async () => {
    // Regression: a stale `elizaos:active-server` pinned the client to a dead
    // remote (here 195.201.57.227:19736) whose requests are CSP-blocked. The
    // poll loop used to retry the dead address until BACKEND_TIMEOUT and wedge
    // first-run forever. It must instead clear the saved server, re-point to
    // the local origin, and reach the backend.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://localhost:2138", protocol: "http:" },
    };
    clientMock.getBaseUrl.mockReturnValue("http://195.201.57.227:19736");
    const networkError = Object.assign(
      new Error("Refused to connect — violates Content Security Policy"),
      { kind: "network", path: "/api/auth/status" },
    );
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus
      .mockRejectedValueOnce(networkError)
      .mockResolvedValue({
        required: false,
        pairingEnabled: false,
        expiresAt: null,
      });

    const staleRemote = {
      id: "remote:http://195.201.57.227:19736",
      kind: "remote" as const,
      label: "195.201.57.227:19736",
      apiBase: "http://195.201.57.227:19736",
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: staleRemote,
      restoredActiveServer: staleRemote,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: false,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clearPersistedActiveServer).toHaveBeenCalledTimes(1);
    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(null);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
  });

  it("requests a native local-agent start on every poll iteration for the polled base", async () => {
    // #15189: on a fresh install the native auto-start gate ran before the
    // renderer pre-seeded the local target, so the agent the poll waits for
    // was never asked to start. The poll must fire the start request for the
    // base it polls on EVERY iteration — one request can be lost to a service
    // teardown race or a child death, and native start is idempotent, so
    // re-asking each retry is what makes the revive self-healing.
    const deps = createDeps();
    const dispatch = vi.fn();
    const ipcBase = ANDROID_LOCAL_AGENT_IPC_BASE;
    clientMock.getBaseUrl.mockReturnValue(ipcBase);
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus
      .mockRejectedValueOnce(
        Object.assign(new Error("socket not accepting"), {
          kind: "network",
          path: "/api/auth/status",
        }),
      )
      .mockResolvedValue({
        required: false,
        pairingEnabled: false,
        expiresAt: null,
      });

    const localServer = {
      id: "android:local-agent",
      kind: "remote" as const,
      label: "On-device agent",
      apiBase: ipcBase,
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: localServer,
      restoredActiveServer: localServer,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: false,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    // Two iterations ran (one rejected probe, one success) → two requests,
    // both for the polled base. The per-iteration re-ask is deliberate: it is
    // what revives the agent when an earlier request was lost.
    expect(
      androidBootStateMock.requestAndroidLocalAgentStartForUrl,
    ).toHaveBeenCalledTimes(2);
    expect(
      androidBootStateMock.requestAndroidLocalAgentStartForUrl.mock.calls.map(
        (call) => call[0],
      ),
    ).toEqual([ipcBase, ipcBase]);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
  });

  it("routes a DEV-UI-shell (port 2138) same-origin proxy outage to offline first-run instead of waiting for timeout", async () => {
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: {
        origin: "http://localhost:2138",
        protocol: "http:",
        port: "2138",
      },
    };
    clientMock.getBaseUrl.mockReturnValue("");
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error("Bad Gateway"), {
        kind: "http",
        status: 502,
        path: "/api/auth/status",
      }),
    );

    const staleLocal = {
      id: "local:desktop",
      kind: "local" as const,
      label: "Local agent",
      apiBase: "http://127.0.0.1:31337",
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: false,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: false,
        defaultTarget: null,
      },
      {
        persistedActiveServer: staleLocal,
        restoredActiveServer: staleLocal,
        shouldPreserveCompletedFirstRun: false,
        hadPriorFirstRun: true,
      },
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clearPersistedActiveServer).toHaveBeenCalledTimes(1);
    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(null);
    expect(deps.setFirstRunOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.any(Array),
        models: expect.any(Object),
      }),
    );
    expect(deps.setFirstRunComplete).toHaveBeenCalledWith(false);
    expect(deps.setFirstRunLoading).toHaveBeenCalledWith(false);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_UNAVAILABLE_FIRST_RUN",
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
  });

  it("does NOT eject an established hosted-web user to first-run on a transient same-origin 5xx", async () => {
    // Regression guard for the prod-eject blocker: on hosted web (port != 2138)
    // a transient gateway 502/503/504 must retry to the deadline, never reset
    // the established session into onboarding.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: {
        origin: "https://app.elizacloud.ai",
        protocol: "https:",
        port: "",
      },
    };
    clientMock.getBaseUrl.mockReturnValue("");
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error("Service Unavailable"), {
        kind: "http",
        status: 503,
        path: "/api/auth/status",
      }),
    );

    const hostedServer = {
      id: "cloud:hosted",
      kind: "remote" as const,
      label: "Eliza Cloud",
      apiBase: "https://app.elizacloud.ai",
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: false,
        backendTimeoutMs: 50,
        agentReadyTimeoutMs: 50,
        probeForExistingInstall: false,
        defaultTarget: null,
      },
      {
        persistedActiveServer: hostedServer,
        restoredActiveServer: hostedServer,
        shouldPreserveCompletedFirstRun: false,
        hadPriorFirstRun: true,
      },
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    // The destructive reset must NOT happen for an established hosted session.
    expect(clearPersistedActiveServer).not.toHaveBeenCalled();
    expect(clientMock.setBaseUrl).not.toHaveBeenCalledWith(null);
    expect(deps.setFirstRunComplete).not.toHaveBeenCalledWith(false);
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "BACKEND_UNAVAILABLE_FIRST_RUN",
    });
    // Instead it retries to the deadline and surfaces a recoverable timeout.
    expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
  });

  it("recovers to local when a fresh first-run dead-ends on a remote with auth required + pairing disabled", async () => {
    // Regression: a stale cloud active-server (control plane) left from an
    // aborted cloud sign-in returns required:true + pairingEnabled:false. With
    // no token and no prior first-run the user can neither pair nor sign in —
    // the "Pairing is not enabled on this server" dead end. Must recover to the
    // local origin instead of stranding them on the pairing gate.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://localhost:2138", protocol: "http:" },
    };
    clientMock.getBaseUrl.mockReturnValue("https://api.elizacloud.ai");
    clientMock.hasToken.mockReturnValue(false);
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus
      .mockResolvedValueOnce({
        required: true,
        authenticated: false,
        pairingEnabled: false,
        expiresAt: null,
      })
      .mockResolvedValue({
        required: false,
        authenticated: false,
        pairingEnabled: false,
        expiresAt: null,
      });
    const staleCloud = {
      id: "cloud:api.elizacloud.ai",
      kind: "cloud" as const,
      label: "Eliza Cloud",
      apiBase: "https://api.elizacloud.ai",
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: staleCloud,
      restoredActiveServer: staleCloud,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: false,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clearPersistedActiveServer).toHaveBeenCalledTimes(1);
    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(null);
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "BACKEND_AUTH_REQUIRED",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
  });

  it("recovers to local even for a returning user when the saved remote dead-ends on pairing-disabled", async () => {
    // Regression: a returning user (hadPriorFirstRun=true, e.g. they completed
    // onboarding against the cloud in a past session) whose saved remote now
    // returns required:true + pairingEnabled:false is on the SAME dead-end —
    // no token, no pairing, no token field on the screen. Prior-onboarding must
    // NOT keep them stranded; recovery still falls back to the local origin.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://localhost:2138", protocol: "http:" },
    };
    clientMock.getBaseUrl.mockReturnValue("https://api.elizacloud.ai");
    clientMock.hasToken.mockReturnValue(false);
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus
      .mockResolvedValueOnce({
        required: true,
        authenticated: false,
        pairingEnabled: false,
        expiresAt: null,
      })
      .mockResolvedValue({
        required: false,
        authenticated: false,
        pairingEnabled: false,
        expiresAt: null,
      });
    const staleCloud = {
      id: "cloud:api.elizacloud.ai",
      kind: "cloud" as const,
      label: "Eliza Cloud",
      apiBase: "https://api.elizacloud.ai",
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: staleCloud,
      restoredActiveServer: staleCloud,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: true,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clearPersistedActiveServer).toHaveBeenCalledTimes(1);
    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(null);
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "BACKEND_AUTH_REQUIRED",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
  });

  it("recovers from a loopback base pinned at the agent's raw port (dev-in-browser 401 dead-end)", async () => {
    // The user's exact case: pinned to 127.0.0.1:31337 (the agent's raw port),
    // which 401s the cross-origin browser request -> required:true +
    // pairingEnabled:false. Loopback bases were previously skipped by
    // isRecoverableRemoteBase; the auth-walled path now recovers (allowLoopback)
    // to the same-origin proxy that actually serves this page.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://localhost:2138", protocol: "http:" },
    };
    clientMock.getBaseUrl.mockReturnValue("http://127.0.0.1:31337");
    clientMock.hasToken.mockReturnValue(false);
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus
      .mockResolvedValueOnce({
        required: true,
        authenticated: false,
        pairingEnabled: false,
        expiresAt: null,
      })
      .mockResolvedValue({
        required: false,
        authenticated: false,
        pairingEnabled: false,
        expiresAt: null,
      });
    const rawPort = {
      id: "remote:raw-agent-port",
      kind: "remote" as const,
      label: "Raw agent port",
      apiBase: "http://127.0.0.1:31337",
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: rawPort,
      restoredActiveServer: rawPort,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: true,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clearPersistedActiveServer).toHaveBeenCalledTimes(1);
    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(null);
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "BACKEND_AUTH_REQUIRED",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
  });

  it("does NOT auto-recover when pairing is ENABLED (the user can actually pair)", async () => {
    // Guard: recovery is only for the pairing-DISABLED dead end. When pairing is
    // enabled there is a real way forward (pair this device), so keep the gate
    // and do not hijack the user's remote — regardless of prior first-run.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://localhost:2138", protocol: "http:" },
    };
    clientMock.getBaseUrl.mockReturnValue("https://my-remote.example");
    clientMock.hasToken.mockReturnValue(false);
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockResolvedValue({
      required: true,
      authenticated: false,
      pairingEnabled: true,
      expiresAt: null,
    });
    const remote = {
      id: "remote:my",
      kind: "remote" as const,
      label: "my-remote",
      apiBase: "https://my-remote.example",
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: remote,
      restoredActiveServer: remote,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: true,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_AUTH_REQUIRED" });
    expect(clearPersistedActiveServer).not.toHaveBeenCalled();
  });

  it("on Capacitor native, a pairing-enabled REMOTE 401 exits to the pairing gate instead of looping (iOS remote-connect)", async () => {
    // Regression: on iOS native, a 401 without a token was always assumed to be
    // the transient local-agent token-injection race and fell through to the
    // retry loop. For a REMOTE target the 401 is terminal pairing-required, so
    // the app polled it forever and never reached PairingView. The base URL is
    // not the in-process local agent, so we must exit to the pairing gate like
    // desktop does.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "capacitor://localhost", protocol: "capacitor:" },
    };
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
    };
    clientMock.getBaseUrl.mockReturnValue("http://192.168.0.137:31337");
    clientMock.hasToken.mockReturnValue(false);
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockResolvedValue({
      required: true,
      authenticated: false,
      pairingEnabled: true,
      expiresAt: null,
    });
    clientMock.getFirstRunStatus.mockReset();
    clientMock.getFirstRunStatus.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), {
        status: 401,
        path: "/api/first-run-status",
      }),
    );
    const remote = {
      id: "remote:lan",
      kind: "remote" as const,
      label: "lan-remote",
      apiBase: "http://192.168.0.137:31337",
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: remote,
      restoredActiveServer: remote,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: true,
    };

    try {
      await runPollingBackend(
        deps,
        dispatch,
        {
          supportsLocalRuntime: true,
          backendTimeoutMs: 1000,
          agentReadyTimeoutMs: 1000,
          probeForExistingInstall: true,
          defaultTarget: "embedded-local",
        },
        ctx,
        1,
        { current: 1 },
        { current: false },
        { current: null },
      );

      expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_AUTH_REQUIRED" });
      expect(deps.setPairingEnabled).toHaveBeenCalledWith(true);
    } finally {
      delete (globalThis as Record<string, unknown>).Capacitor;
    }
  });

  it("routes a DELETED dedicated cloud agent to agent selection instead of Backend Unreachable (outer 404)", async () => {
    // Regression: a deleted/unreachable dedicated cloud agent
    // (<id>.elizacloud.ai) 404'd the first auth poll and dead-ended on
    // BACKEND_NOT_FOUND ("Backend Unreachable"). With a cloud token present and
    // the control-plane confirming the agent is gone, clear the dead saved
    // server and route to first-run agent selection.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://localhost:2138", protocol: "http:" },
    };
    clientMock.getBaseUrl.mockReturnValue("https://agent-123.elizacloud.ai");
    clientMock.hasToken.mockReturnValue(true);
    cloudMock.getCloudAuthToken.mockReturnValue("cloud-token");
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error("Not Found"), {
        kind: "http",
        status: 404,
        path: "/api/auth/status",
      }),
    );
    // Control-plane confirms the agent no longer exists.
    clientMock.getCloudCompatAgent.mockRejectedValue(
      Object.assign(new Error("Not Found"), { kind: "http", status: 404 }),
    );

    const staleAgent = {
      id: "cloud:agent-123",
      kind: "cloud" as const,
      label: "Dedicated agent",
      apiBase: "https://agent-123.elizacloud.ai",
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: staleAgent,
      restoredActiveServer: staleAgent,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: true,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clientMock.getCloudCompatAgent).toHaveBeenCalledWith("agent-123");
    expect(clearPersistedActiveServer).toHaveBeenCalledTimes(1);
    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(null);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_NOT_FOUND" });
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
  });

  it("treats a STILL-EXISTING dedicated cloud agent's 404 as first-run-complete (outer 404)", async () => {
    // Guard: when the control-plane confirms the dedicated agent still exists,
    // the first-run-shell 404 means "no shell on a cloud agent" (first-run is
    // done) — go to chat, do NOT clear the saved server.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://localhost:2138", protocol: "http:" },
    };
    clientMock.getBaseUrl.mockReturnValue("https://agent-123.elizacloud.ai");
    clientMock.hasToken.mockReturnValue(true);
    cloudMock.getCloudAuthToken.mockReturnValue("cloud-token");
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error("Not Found"), {
        kind: "http",
        status: 404,
        path: "/api/auth/status",
      }),
    );
    clientMock.getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { agent_id: "agent-123" },
    });

    const agent = {
      id: "cloud:agent-123",
      kind: "cloud" as const,
      label: "Dedicated agent",
      apiBase: "https://agent-123.elizacloud.ai",
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: agent,
      restoredActiveServer: agent,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: true,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clientMock.getCloudCompatAgent).toHaveBeenCalledWith("agent-123");
    expect(clearPersistedActiveServer).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_NOT_FOUND" });
    expect(deps.setFirstRunComplete).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: true,
    });
  });

  it("does not probe first-run setup routes on a live limited cloud agent base", async () => {
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: {
        origin: "http://localhost:2138",
        protocol: "http:",
        port: "2138",
      },
    };
    const activeServer = {
      id: "cloud:agent-123",
      kind: "cloud" as const,
      label: "Dedicated agent",
      apiBase: "https://agent-123.elizacloud.ai",
      accessToken: "cloud-token",
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: activeServer,
      restoredActiveServer: activeServer,
      shouldPreserveCompletedFirstRun: true,
      hadPriorFirstRun: true,
    };
    clientMock.getBaseUrl.mockReturnValue("https://agent-123.elizacloud.ai");
    clientMock.hasToken.mockReturnValue(true);
    clientMock.getAuthStatus.mockResolvedValue({
      required: false,
      authenticated: true,
      pairingEnabled: false,
      expiresAt: null,
    });

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clientMock.getFirstRunStatus).not.toHaveBeenCalled();
    expect(clientMock.getFirstRunOptions).not.toHaveBeenCalled();
    expect(deps.setFirstRunCloudProvisionedContainer).toHaveBeenCalledWith(
      false,
    );
    expect(deps.setFirstRunComplete).toHaveBeenCalledWith(true);
    expect(deps.setFirstRunLoading).toHaveBeenCalledWith(false);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: true,
    });
  });

  it("force-completes first-run on a limited cloud base via firstRunCompletionCommittedRef (not just shouldPreserveCompletedFirstRun)", async () => {
    const deps = createDeps();
    // The OTHER operand of the force-complete gate: an in-session committed
    // first-run completion, with shouldPreserveCompletedFirstRun:false.
    deps.firstRunCompletionCommittedRef.current = true;
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: {
        origin: "http://localhost:2138",
        protocol: "http:",
        port: "2138",
      },
    };
    const activeServer = {
      id: "cloud:agent-123",
      kind: "cloud" as const,
      label: "Dedicated agent",
      apiBase: "https://agent-123.elizacloud.ai",
      accessToken: "cloud-token",
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: activeServer,
      restoredActiveServer: activeServer,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: true,
    };
    clientMock.getBaseUrl.mockReturnValue("https://agent-123.elizacloud.ai");
    clientMock.hasToken.mockReturnValue(true);
    clientMock.getAuthStatus.mockResolvedValue({
      required: false,
      authenticated: true,
      pairingEnabled: false,
      expiresAt: null,
    });

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clientMock.getFirstRunStatus).not.toHaveBeenCalled();
    expect(deps.setFirstRunComplete).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: true,
    });
  });

  it("does NOT strand on Backend Unreachable when the agent lookup is inconclusive (no cloud token)", async () => {
    // Without a cloud token we cannot verify the dedicated agent. Rather than
    // wrongly clearing the saved server, fall back to the prior behaviour: the
    // 404 is treated as first-run-complete (a dedicated cloud agent has no shell),
    // never a hard "Backend Unreachable" dead-end.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://localhost:2138", protocol: "http:" },
    };
    clientMock.getBaseUrl.mockReturnValue("https://agent-123.elizacloud.ai");
    clientMock.hasToken.mockReturnValue(true);
    cloudMock.getCloudAuthToken.mockReturnValue(null);
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error("Not Found"), {
        kind: "http",
        status: 404,
        path: "/api/auth/status",
      }),
    );

    const agent = {
      id: "cloud:agent-123",
      kind: "cloud" as const,
      label: "Dedicated agent",
      apiBase: "https://agent-123.elizacloud.ai",
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: agent,
      restoredActiveServer: agent,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: true,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clientMock.getCloudCompatAgent).not.toHaveBeenCalled();
    expect(clearPersistedActiveServer).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_NOT_FOUND" });
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: true,
    });
  });

  it("routes a DELETED dedicated cloud agent to agent selection from the options-fetch 404 (inner 404)", async () => {
    // The inner first-run-options loop has its own 404 branch. A dedicated cloud
    // agent that returns auth:ok + firstRun incomplete but 404s on options must
    // verify + recover the same way as the outer catch.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://localhost:2138", protocol: "http:" },
    };
    clientMock.getBaseUrl.mockReturnValue("https://agent-123.elizacloud.ai");
    clientMock.hasToken.mockReturnValue(true);
    cloudMock.getCloudAuthToken.mockReturnValue("cloud-token");
    clientMock.getAuthStatus.mockResolvedValue({
      required: false,
      authenticated: true,
      pairingEnabled: false,
      expiresAt: null,
    });
    clientMock.getFirstRunStatus.mockResolvedValue({
      complete: false,
      cloudProvisioned: false,
    });
    clientMock.getFirstRunOptions.mockRejectedValue(
      Object.assign(new Error("Not Found"), {
        kind: "http",
        status: 404,
        path: "/api/first-run/options",
      }),
    );
    clientMock.getCloudCompatAgent.mockRejectedValue(
      Object.assign(new Error("Not Found"), { kind: "http", status: 404 }),
    );

    const staleAgent = {
      id: "cloud:agent-123",
      kind: "cloud" as const,
      label: "Dedicated agent",
      apiBase: "https://agent-123.elizacloud.ai",
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: staleAgent,
      restoredActiveServer: staleAgent,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: true,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clientMock.getCloudCompatAgent).toHaveBeenCalledWith("agent-123");
    expect(clearPersistedActiveServer).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_NOT_FOUND" });
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
  });
});

describe("shouldFallBackToLocalOrigin", () => {
  const eligible = {
    error: Object.assign(new Error("Failed to fetch"), {
      kind: "network",
      path: "/api/auth/status",
    }),
    clientBaseUrl: "http://195.201.57.227:19736",
    pageOrigin: "http://localhost:2138",
    pageProtocol: "http:",
    isNativeMobile: false,
  };

  it("falls back for an unreachable non-local server on a web origin", () => {
    expect(shouldFallBackToLocalOrigin(eligible)).toBe(true);
  });

  it("does not fall back on native mobile (the remote IS the agent)", () => {
    expect(
      shouldFallBackToLocalOrigin({ ...eligible, isNativeMobile: true }),
    ).toBe(false);
  });

  it("does not fall back when the server answered with an HTTP status", () => {
    expect(
      shouldFallBackToLocalOrigin({
        ...eligible,
        error: Object.assign(new Error("Internal error"), {
          kind: "http",
          status: 500,
          path: "/api/auth/status",
        }),
      }),
    ).toBe(false);
  });

  it("does not fall back for a loopback base (that is the local agent)", () => {
    expect(
      shouldFallBackToLocalOrigin({
        ...eligible,
        clientBaseUrl: "http://127.0.0.1:31337",
      }),
    ).toBe(false);
  });

  it("does not fall back when already pinned to the page's own origin", () => {
    expect(
      shouldFallBackToLocalOrigin({
        ...eligible,
        clientBaseUrl: "http://localhost:2138",
      }),
    ).toBe(false);
  });

  it("does not fall back when there is no client base (already same-origin)", () => {
    expect(
      shouldFallBackToLocalOrigin({ ...eligible, clientBaseUrl: "" }),
    ).toBe(false);
  });

  it("does not fall back off a web origin (e.g. a desktop custom scheme)", () => {
    expect(
      shouldFallBackToLocalOrigin({ ...eligible, pageProtocol: "views:" }),
    ).toBe(false);
  });
});

describe("runPollingBackend cancellation during options fetch", () => {
  it("bails without mutating state when cancelled mid-fetch", async () => {
    // Regression: the post-Promise.all path (first-run options + config) had
    // no `cancelled.current` guard, so an effect torn down while the fetch was
    // in flight still called setFirstRunOptions and dispatched BACKEND_REACHED
    // on a dead effect. Flip `cancelled` the instant options are fetched and
    // assert nothing downstream fires.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://localhost:2138", protocol: "http:" },
    };
    const cancelled = { current: false };
    clientMock.getFirstRunOptions.mockImplementation(async () => {
      cancelled.current = true; // effect cleanup raced the in-flight fetch
      return firstRunOptions();
    });
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: null,
      restoredActiveServer: {
        id: "local:desktop",
        kind: "local",
        label: "Local agent",
        apiBase: "http://127.0.0.1:34137",
      },
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: false,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      cancelled,
      { current: null },
    );

    expect(deps.setFirstRunOptions).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
  });
});

describe("runPollingBackend bounded native boot (#11030)", () => {
  const nativePolicy = {
    supportsLocalRuntime: true,
    backendTimeoutMs: 30_000,
    agentReadyTimeoutMs: 30_000,
    probeForExistingInstall: false,
    defaultTarget: "cloud-managed" as const,
  };

  const mobileLocalServer = {
    id: "local:mobile",
    kind: "remote" as const,
    label: "On-device agent",
    apiBase: "eliza-local-agent://ipc",
  };

  function nativeCtx(): RestoringSessionCtx {
    return {
      persistedActiveServer: mobileLocalServer,
      restoredActiveServer: mobileLocalServer,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: true,
    };
  }

  function installNativeWindow(): void {
    (globalThis as { window?: unknown }).window = {
      location: { origin: "capacitor://localhost", protocol: "capacitor:" },
    };
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
    };
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).Capacitor;
  });

  it("still reaches BACKEND_TIMEOUT when a probe NEVER settles (hung transport, #11030 raw-proxy deadlock)", async () => {
    // The on-device failure shape: the iOS transport awaited Capacitor's raw
    // plugin proxy — a thenable whose `then` never invokes its callbacks — so
    // client.getAuthStatus() neither resolved nor rejected. Without the
    // deadline race the loop freezes BEFORE its own deadline check and the
    // phone sits on "Booting up…" forever with no timeout card.
    const deps = createDeps();
    const dispatch = vi.fn();
    installNativeWindow();
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockImplementation(
      () => new Promise<never>(() => {}),
    );

    await runPollingBackend(
      deps,
      dispatch,
      { ...nativePolicy, backendTimeoutMs: 1_200 },
      nativeCtx(),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
    expect(deps.setStartupError).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "backend-timeout",
        detail: expect.stringContaining("did not settle"),
      }),
    );
  }, 15_000);

  it("fails fast to AGENT_ERROR with the REAL message on the iOS cloud-mode IPC policy rejection", async () => {
    // The exact #11030 renderer failure: a stale persisted "cloud" runtime
    // mode policy-locks the local-agent transport, so every startup probe
    // rejects with the same TypeError until the 3-minute deadline — an
    // infinite "Booting up…" splash. The poll must surface the error phase
    // (which renders Retry) with the real message immediately.
    const deps = createDeps();
    const dispatch = vi.fn();
    installNativeWindow();
    const policyMessage =
      "iOS cloud builds cannot use local-agent IPC unless local runtime mode is active";
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new TypeError(policyMessage), {
        kind: "network",
        path: "/api/auth/status",
      }),
    );

    await runPollingBackend(
      deps,
      dispatch,
      nativePolicy,
      nativeCtx(),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(dispatch).toHaveBeenCalledWith({
      type: "AGENT_ERROR",
      message: policyMessage,
    });
    expect(deps.setStartupError).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "agent-error",
        message: policyMessage,
      }),
    );
    expect(deps.setFirstRunLoading).toHaveBeenCalledWith(false);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
  });

  it("fails fast on the native Agent plugin's missing-endpoint error", async () => {
    const deps = createDeps();
    const dispatch = vi.fn();
    installNativeWindow();
    const missingEndpoint =
      "iOS Agent requires a configured HTTP endpoint for remote/cloud mode, or runtimeMode=local for dev/sideload local mode. Set Agent.apiBase in capacitor.config, an Info.plist/UserDefaults key such as ELIZA_IOS_API_BASE or ELIZA_AGENT_API_BASE, or a simulator environment variable.";
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error(missingEndpoint), {
        kind: "network",
        path: "/api/auth/status",
      }),
    );

    await runPollingBackend(
      deps,
      dispatch,
      nativePolicy,
      nativeCtx(),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(dispatch).toHaveBeenCalledWith({
      type: "AGENT_ERROR",
      message: missingEndpoint,
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
  });

  it("does NOT fail fast on the same message off-native (web keeps the plain retry/timeout path)", async () => {
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://localhost:4173", protocol: "http:" },
    };
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(
        new Error(
          "iOS cloud builds cannot use local-agent IPC unless local runtime mode is active",
        ),
        { kind: "network", path: "/api/auth/status" },
      ),
    );

    await runPollingBackend(
      deps,
      dispatch,
      { ...nativePolicy, backendTimeoutMs: 300 },
      {
        persistedActiveServer: mobileLocalServer,
        restoredActiveServer: mobileLocalServer,
        shouldPreserveCompletedFirstRun: false,
        hadPriorFirstRun: true,
      },
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "AGENT_ERROR" }),
    );
    expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
  });

  it("keeps Android cold boots in progress when native boot-state says booting", async () => {
    const deps = createDeps();
    const dispatch = vi.fn();
    installNativeWindow();
    clientMock.getBaseUrl.mockReturnValue(mobileLocalServer.apiBase);
    androidBootStateMock.getAndroidLocalAgentBootStateForUrl.mockResolvedValue({
      state: "booting",
      reason: "launcher is still within boot grace",
    });
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error("Local agent request failed"), {
        kind: "network",
        path: "/api/auth/status",
      }),
    );

    await runPollingBackend(
      deps,
      dispatch,
      {
        ...nativePolicy,
        backendTimeoutMs: 600,
        nativeConsecutiveFailureBudgetMs: 150,
      },
      nativeCtx(),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(
      androidBootStateMock.getAndroidLocalAgentBootStateForUrl,
    ).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
    expect(deps.setStartupError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("consecutive failures"),
      }),
    );
  });

  it("burns the Android native failure budget when boot-state says dead", async () => {
    const deps = createDeps();
    const dispatch = vi.fn();
    installNativeWindow();
    clientMock.getBaseUrl.mockReturnValue(mobileLocalServer.apiBase);
    androidBootStateMock.getAndroidLocalAgentBootStateForUrl.mockResolvedValue({
      state: "dead",
      reason: "agent exited: exit 127",
    });
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error("Local agent request failed"), {
        kind: "network",
        path: "/api/auth/status",
      }),
    );

    await runPollingBackend(
      deps,
      dispatch,
      { ...nativePolicy, nativeConsecutiveFailureBudgetMs: 150 },
      nativeCtx(),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
    expect(deps.setStartupError).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "backend-timeout",
        message: expect.stringContaining("consecutive failures"),
      }),
    );
  });

  it("bounds the native boot: consecutive failures past the native budget surface the last failure", async () => {
    const deps = createDeps();
    const dispatch = vi.fn();
    installNativeWindow();
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error("Failed to fetch"), {
        kind: "network",
        path: "/api/auth/status",
      }),
    );

    await runPollingBackend(
      deps,
      dispatch,
      { ...nativePolicy, nativeConsecutiveFailureBudgetMs: 200 },
      nativeCtx(),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    // The overall backendTimeoutMs (30s) never elapsed — the native
    // consecutive-failure budget produced the terminal transition.
    expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
    expect(deps.setStartupError).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "backend-timeout",
        message: expect.stringContaining("Last failure:"),
        detail: expect.stringContaining("Failed to fetch"),
      }),
    );
  });

  it("resets the native failure streak on any successful probe (a cold-booting agent is not a broken transport)", async () => {
    const deps = createDeps();
    const dispatch = vi.fn();
    installNativeWindow();
    const networkError = () =>
      Object.assign(new Error("Failed to fetch"), {
        kind: "network",
        path: "/api/auth/status",
      });
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue({
        required: false,
        authenticated: true,
        pairingEnabled: false,
        expiresAt: null,
      });
    clientMock.getFirstRunStatus.mockReset();
    clientMock.getFirstRunStatus
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue({ complete: true, cloudProvisioned: false });

    // Budget 450ms: WITHOUT the reset, the second failure (~500ms in, after
    // the first backoff) would exceed the budget and dead-end on
    // BACKEND_TIMEOUT. WITH the reset (the auth probe between the two
    // failures succeeded) the streak restarts and the third round completes.
    await runPollingBackend(
      deps,
      dispatch,
      { ...nativePolicy, nativeConsecutiveFailureBudgetMs: 450 },
      nativeCtx(),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: true,
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
  });
});

describe("runPollingBackend progress-aware native budget + dead-cloud recovery (iOS boot automation D1)", () => {
  const originalIosFullBunAvailable =
    process.env.VITE_ELIZA_IOS_FULL_BUN_AVAILABLE;

  const nativePolicy = {
    supportsLocalRuntime: true,
    backendTimeoutMs: 30_000,
    agentReadyTimeoutMs: 30_000,
    probeForExistingInstall: false,
    defaultTarget: "cloud-managed" as const,
  };

  function nativeCtx(server: {
    id: string;
    kind: "local" | "cloud" | "remote";
    label: string;
    apiBase: string;
  }): RestoringSessionCtx {
    return {
      persistedActiveServer: server,
      restoredActiveServer: server,
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: true,
    };
  }

  const deadCloudServer = {
    id: "cloud:67ae7b68",
    kind: "cloud" as const,
    label: "Cloud agent",
    apiBase: "https://67ae7b68-6351-41db-a79a-a1d157265018.elizacloud.ai",
  };

  function installNativeWindow(options?: {
    persistedRuntimeMode?: string | null;
  }): { setItemCalls: Array<[string, string]> } {
    const setItemCalls: Array<[string, string]> = [];
    const store = new Map<string, string>();
    if (options?.persistedRuntimeMode) {
      store.set("eliza:mobile-runtime-mode", options.persistedRuntimeMode);
    }
    (globalThis as { window?: unknown }).window = {
      location: { origin: "capacitor://localhost", protocol: "capacitor:" },
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
          setItemCalls.push([key, value]);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    };
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
    };
    return { setItemCalls };
  }

  beforeEach(async () => {
    process.env.VITE_ELIZA_IOS_FULL_BUN_AVAILABLE = "true";
    const transport = await import("../api/ios-local-agent-transport");
    transport.resetIosNativeAgentBootProgressForTests();
  });

  afterEach(async () => {
    if (originalIosFullBunAvailable === undefined) {
      delete process.env.VITE_ELIZA_IOS_FULL_BUN_AVAILABLE;
    } else {
      process.env.VITE_ELIZA_IOS_FULL_BUN_AVAILABLE =
        originalIosFullBunAvailable;
    }
    delete (globalThis as Record<string, unknown>).Capacitor;
    const transport = await import("../api/ios-local-agent-transport");
    transport.resetIosNativeAgentBootProgressForTests();
  });

  it("does NOT burn the native failure budget while the in-process agent is booting (503s are progress, not transport failures)", async () => {
    const transport = await import("../api/ios-local-agent-transport");
    transport.resetIosNativeAgentBootProgressForTests();
    transport.recordIosNativeAgentBootPhase("starting");

    const deps = createDeps();
    const dispatch = vi.fn();
    installNativeWindow();
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error("Agent is starting"), {
        kind: "http",
        status: 503,
        path: "/api/auth/status",
      }),
    );

    // Budget 150ms << overall deadline 600ms. WITHOUT progress-awareness the
    // budget fires at ~150ms with the "consecutive failures" card; WITH it,
    // the poll keeps going until the overall deadline.
    await runPollingBackend(
      deps,
      dispatch,
      {
        ...nativePolicy,
        backendTimeoutMs: 600,
        nativeConsecutiveFailureBudgetMs: 150,
      },
      nativeCtx({
        id: "local:mobile",
        kind: "remote",
        label: "On-device agent",
        apiBase: "eliza-local-agent://ipc",
      }),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
    expect(deps.setStartupError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("consecutive failures"),
      }),
    );
  });

  it("keeps the budget paused on fresh ready-phase heartbeats, too", async () => {
    const transport = await import("../api/ios-local-agent-transport");
    transport.resetIosNativeAgentBootProgressForTests();
    transport.recordIosNativeAgentBootPhase("ready");

    const deps = createDeps();
    const dispatch = vi.fn();
    installNativeWindow();
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockImplementation(async () => {
      // Each poll produces a structured response from the live bridge (a
      // mid-boot 503) — which the transport records as a heartbeat.
      transport.recordIosNativeAgentBootHeartbeat();
      throw Object.assign(new Error("Service Unavailable"), {
        kind: "http",
        status: 503,
        path: "/api/auth/status",
      });
    });

    await runPollingBackend(
      deps,
      dispatch,
      {
        ...nativePolicy,
        backendTimeoutMs: 600,
        nativeConsecutiveFailureBudgetMs: 150,
      },
      nativeCtx({
        id: "local:mobile",
        kind: "remote",
        label: "On-device agent",
        apiBase: "eliza-local-agent://ipc",
      }),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
    expect(deps.setStartupError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("consecutive failures"),
      }),
    );
  });

  it("burns the budget normally once the agent boot is in a terminal error state", async () => {
    const transport = await import("../api/ios-local-agent-transport");
    transport.resetIosNativeAgentBootProgressForTests();
    transport.recordIosNativeAgentBootPhase("error", "engine start failed");

    const deps = createDeps();
    const dispatch = vi.fn();
    installNativeWindow();
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error("Failed to fetch"), {
        kind: "network",
        path: "/api/auth/status",
      }),
    );

    await runPollingBackend(
      deps,
      dispatch,
      { ...nativePolicy, nativeConsecutiveFailureBudgetMs: 150 },
      nativeCtx({
        id: "local:mobile",
        kind: "remote",
        label: "On-device agent",
        apiBase: "eliza-local-agent://ipc",
      }),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
    expect(deps.setStartupError).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "backend-timeout",
        message: expect.stringContaining("consecutive failures"),
      }),
    );
  });

  it("recovers a stale persisted cloud mode to the ON-DEVICE agent on the dedicated proxy's terminal sandbox-error 503", async () => {
    // The REAL on-device failure this leg root-caused: persisted
    // eliza:mobile-runtime-mode="cloud" pins a local-capable build to a
    // dedicated cloud agent whose sandbox is status:"error" — the proxy
    // 503s "Agent is in an error state. Resolve the failure before
    // connecting." on every poll, on every launch path (icon tap,
    // devicectl, XCUITest), until the 90s budget fires the timeout card.
    const deps = createDeps();
    const dispatch = vi.fn();
    const { setItemCalls } = installNativeWindow({
      persistedRuntimeMode: "cloud",
    });

    let base = deadCloudServer.apiBase;
    clientMock.getBaseUrl.mockImplementation(() => base);
    clientMock.setBaseUrl.mockImplementation((next: string | null) => {
      base = next ?? "";
    });
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockImplementation(async () => {
      if (base === "eliza-local-agent://ipc") {
        return {
          required: false,
          authenticated: true,
          pairingEnabled: false,
          expiresAt: null,
        };
      }
      throw Object.assign(
        new Error(
          "Agent is in an error state. Resolve the failure before connecting.",
        ),
        { kind: "http", status: 503, path: "/api/auth/status" },
      );
    });
    clientMock.getFirstRunStatus.mockResolvedValue({
      complete: true,
      cloudProvisioned: false,
    });

    await runPollingBackend(
      deps,
      dispatch,
      nativePolicy,
      nativeCtx(deadCloudServer),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    // Recovered to the bundled on-device agent and completed startup.
    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(
      "eliza-local-agent://ipc",
    );
    expect(setItemCalls).toContainEqual(["eliza:mobile-runtime-mode", "local"]);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: true,
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
  });

  it("routes the terminal sandbox-error 503 to agent selection when on-device recovery is not applicable", async () => {
    // No persisted cloud runtime mode (e.g. web / a build without the local
    // engine): clear the dead saved server and go to first-run agent
    // selection instead of polling the terminal 503 into the timeout card.
    const deps = createDeps();
    const dispatch = vi.fn();
    installNativeWindow({ persistedRuntimeMode: null });

    clientMock.getBaseUrl.mockReturnValue(deadCloudServer.apiBase);
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(
        new Error(
          "Agent is in an error state. Resolve the failure before connecting.",
        ),
        { kind: "http", status: 503, path: "/api/auth/status" },
      ),
    );

    await runPollingBackend(
      deps,
      dispatch,
      nativePolicy,
      nativeCtx(deadCloudServer),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(vi.mocked(clearPersistedActiveServer)).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
  });

  it("recovers a stale persisted cloud mode to the ON-DEVICE agent when the dedicated cloud agent is DELETED (outer 404)", async () => {
    // Follow-on state of the same root cause: once the dead dedicated agent
    // is deleted outright, the proxy answers 404 "agent not found or not
    // running". A local-capable build with the stale persisted cloud mode
    // must recover to the bundled agent, not bounce the user to agent
    // selection.
    const deps = createDeps();
    const dispatch = vi.fn();
    const { setItemCalls } = installNativeWindow({
      persistedRuntimeMode: "cloud",
    });
    cloudMock.getCloudAuthToken.mockReturnValue("cloud-token");

    let base = deadCloudServer.apiBase;
    clientMock.getBaseUrl.mockImplementation(() => base);
    clientMock.setBaseUrl.mockImplementation((next: string | null) => {
      base = next ?? "";
    });
    clientMock.hasToken.mockReturnValue(true);
    clientMock.getCloudCompatAgent.mockRejectedValue(
      Object.assign(new Error("agent not found"), {
        kind: "http",
        status: 404,
      }),
    );
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockImplementation(async () => {
      if (base === "eliza-local-agent://ipc") {
        return {
          required: false,
          authenticated: true,
          pairingEnabled: false,
          expiresAt: null,
        };
      }
      throw Object.assign(new Error("agent not found or not running"), {
        kind: "http",
        status: 404,
        path: "/api/auth/status",
      });
    });
    clientMock.getFirstRunStatus.mockResolvedValue({
      complete: true,
      cloudProvisioned: false,
    });

    await runPollingBackend(
      deps,
      dispatch,
      nativePolicy,
      nativeCtx(deadCloudServer),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(
      "eliza-local-agent://ipc",
    );
    expect(setItemCalls).toContainEqual(["eliza:mobile-runtime-mode", "local"]);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: true,
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
  });

  it("recovers to the on-device agent when the persisted cloud base dead-ends past the whole native budget", async () => {
    // Unreachable (not terminally-503ing) cloud base: after the full
    // consecutive-failure budget, a local-capable native build with a stale
    // persisted cloud mode flips to the bundled agent instead of stranding
    // the user on the timeout card.
    vi.useFakeTimers();
    const transport = await import("../api/ios-local-agent-transport");
    transport.resetIosNativeAgentBootProgressForTests();
    const deps = createDeps();
    const dispatch = vi.fn();
    const { setItemCalls } = installNativeWindow({
      persistedRuntimeMode: "cloud",
    });

    let base = deadCloudServer.apiBase;
    clientMock.getBaseUrl.mockImplementation(() => base);
    clientMock.setBaseUrl.mockImplementation((next: string | null) => {
      base = next ?? "";
    });
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockImplementation(async () => {
      if (base === "eliza-local-agent://ipc") {
        return {
          required: false,
          authenticated: true,
          pairingEnabled: false,
          expiresAt: null,
        };
      }
      throw Object.assign(new Error("Failed to fetch"), {
        kind: "network",
        path: "/api/auth/status",
      });
    });
    clientMock.getFirstRunStatus.mockResolvedValue({
      complete: true,
      cloudProvisioned: false,
    });

    try {
      const run = runPollingBackend(
        deps,
        dispatch,
        { ...nativePolicy, nativeConsecutiveFailureBudgetMs: 150 },
        nativeCtx(deadCloudServer),
        1,
        { current: 1 },
        { current: false },
        { current: null },
      );
      let settled = false;
      const settledRun = run.finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 800 && !settled; i++) {
        (globalThis as Record<string, unknown>).Capacitor = {
          isNativePlatform: () => true,
        };
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(settled).toBe(true);
      await settledRun;
    } finally {
      vi.useRealTimers();
    }

    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(
      "eliza-local-agent://ipc",
    );
    expect(setItemCalls).toContainEqual(["eliza:mobile-runtime-mode", "local"]);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: true,
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
  });

  it("never auto-flips a user-configured remote-mac mode to the on-device agent", async () => {
    vi.useFakeTimers();
    const deps = createDeps();
    const dispatch = vi.fn();
    const { setItemCalls } = installNativeWindow({
      persistedRuntimeMode: "remote-mac",
    });
    const remoteServer = {
      id: "remote:mac",
      kind: "remote" as const,
      label: "My Mac",
      apiBase: "http://192.168.0.137:31337",
    };
    clientMock.getBaseUrl.mockReturnValue(remoteServer.apiBase);
    clientMock.getAuthStatus.mockReset();
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error("Failed to fetch"), {
        kind: "network",
        path: "/api/auth/status",
      }),
    );

    const run = runPollingBackend(
      deps,
      dispatch,
      { ...nativePolicy, nativeConsecutiveFailureBudgetMs: 150 },
      nativeCtx(remoteServer),
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );
    let settled = false;
    const settledRun = run.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 800 && !settled; i++) {
      (globalThis as Record<string, unknown>).Capacitor = {
        isNativePlatform: () => true,
      };
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(settled).toBe(true);
    await settledRun;

    // Dead-ends on the timeout card (with Retry) — the explicit remote
    // choice is respected, no silent mode flip.
    expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
    expect(clientMock.setBaseUrl).not.toHaveBeenCalledWith(
      "eliza-local-agent://ipc",
    );
    expect(setItemCalls).not.toContainEqual([
      "eliza:mobile-runtime-mode",
      "local",
    ]);
  });

  it("fails a hung probe fast and retries+connects instead of one hang eating the whole budget (#13737)", async () => {
    // The on-device Android boot: the first probe issued while the detached
    // agent is still cold-booting HANGS on the not-yet-listening UDS socket.
    // Old behavior bounded that probe by the ENTIRE remaining budget, so one
    // hang wedged the loop on "Booting up…" for the full window even after the
    // agent became ready. The fix caps each probe at PROBE_REQUEST_TIMEOUT_MS
    // (12s) so it fails fast and the loop retries; the next probe — after the
    // socket is up — connects.
    vi.useFakeTimers();
    try {
      const deps = createDeps();
      const dispatch = vi.fn();
      // First auth probe never settles (hung UDS); the rest resolve (socket up).
      clientMock.getAuthStatus.mockReset();
      let authCalls = 0;
      clientMock.getAuthStatus.mockImplementation(() => {
        authCalls += 1;
        if (authCalls === 1) return new Promise(() => {}); // never resolves
        return Promise.resolve({
          required: false,
          pairingEnabled: false,
          expiresAt: null,
        });
      });

      const run = runPollingBackend(
        deps,
        dispatch,
        {
          // Budget well above the 12s per-request cap so the cap — not the
          // deadline — is what bounds the hung probe.
          supportsLocalRuntime: true,
          backendTimeoutMs: 60_000,
          agentReadyTimeoutMs: 60_000,
          probeForExistingInstall: true,
          defaultTarget: "embedded-local",
        },
        {
          persistedActiveServer: null,
          restoredActiveServer: {
            id: "local:desktop",
            kind: "local",
            label: "Local agent",
            apiBase: "http://127.0.0.1:34137",
          },
          shouldPreserveCompletedFirstRun: false,
          hadPriorFirstRun: false,
        },
        1,
        { current: 1 },
        { current: false },
        { current: null },
      );

      // Advance past the 12s per-request cap (hung probe rejects) + the retry
      // backoff, so the loop reaches the second, resolving probe.
      await vi.advanceTimersByTimeAsync(14_000);
      await run;

      // Retried after the hang (not stuck on the single hung await)…
      expect(authCalls).toBeGreaterThanOrEqual(2);
      // …and connected instead of dead-ending on the timeout card.
      expect(dispatch).toHaveBeenCalledWith({
        type: "BACKEND_REACHED",
        firstRunComplete: false,
      });
      expect(dispatch).not.toHaveBeenCalledWith({ type: "BACKEND_TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("iOS native agent boot progress (transport unit)", () => {
  afterEach(async () => {
    const transport = await import("../api/ios-local-agent-transport");
    transport.resetIosNativeAgentBootProgressForTests();
  });

  it("reports progress while the engine start is pending, bounded by the start silence budget", async () => {
    const transport = await import("../api/ios-local-agent-transport");
    transport.resetIosNativeAgentBootProgressForTests();
    expect(transport.isIosNativeAgentBootInProgress()).toBe(false);

    transport.recordIosNativeAgentBootPhase("starting");
    const startedAt = transport.getIosNativeAgentBootProgress().startedAt;
    expect(startedAt).not.toBeNull();
    expect(transport.isIosNativeAgentBootInProgress()).toBe(true);
    // Still in progress just under the 300s engine-start budget…
    expect(
      transport.isIosNativeAgentBootInProgress((startedAt ?? 0) + 299_000),
    ).toBe(true);
    // …but a hung start past the budget stops counting as progress.
    expect(
      transport.isIosNativeAgentBootInProgress((startedAt ?? 0) + 300_001),
    ).toBe(false);
  });

  it("reports progress after ready only while heartbeats stay fresh", async () => {
    const transport = await import("../api/ios-local-agent-transport");
    transport.resetIosNativeAgentBootProgressForTests();
    transport.recordIosNativeAgentBootPhase("ready");
    const heartbeatAt =
      transport.getIosNativeAgentBootProgress().lastHeartbeatAt;
    expect(heartbeatAt).not.toBeNull();
    expect(transport.isIosNativeAgentBootInProgress()).toBe(true);
    expect(
      transport.isIosNativeAgentBootInProgress((heartbeatAt ?? 0) + 29_000),
    ).toBe(true);
    // Heartbeat silence: budget resumes.
    expect(
      transport.isIosNativeAgentBootInProgress((heartbeatAt ?? 0) + 30_001),
    ).toBe(false);
    // A fresh heartbeat revives progress.
    transport.recordIosNativeAgentBootHeartbeat();
    expect(transport.isIosNativeAgentBootInProgress()).toBe(true);
  });

  it("terminal error is never progress", async () => {
    const transport = await import("../api/ios-local-agent-transport");
    transport.resetIosNativeAgentBootProgressForTests();
    transport.recordIosNativeAgentBootPhase("starting");
    transport.recordIosNativeAgentBootPhase("error", "engine start failed");
    expect(transport.isIosNativeAgentBootInProgress()).toBe(false);
    expect(transport.getIosNativeAgentBootProgress().lastError).toBe(
      "engine start failed",
    );
  });
});

describe("isRecoverableRemoteBase — allowLoopback", () => {
  const base = {
    pageOrigin: "http://localhost:2138",
    pageProtocol: "http:" as string | null,
    isNativeMobile: false,
  };

  it("leaves a loopback base alone by default (connection-error path: local agent still booting)", () => {
    expect(
      isRecoverableRemoteBase({
        ...base,
        clientBaseUrl: "http://127.0.0.1:31337",
      }),
    ).toBe(false);
  });

  it("recovers from a cross-port loopback base when allowLoopback (auth-walled raw agent port)", () => {
    // The dev-in-browser case: pinned to the agent's raw 127.0.0.1:31337 which
    // 401s the browser cross-origin; the same-origin proxy escapes it.
    expect(
      isRecoverableRemoteBase({
        ...base,
        clientBaseUrl: "http://127.0.0.1:31337",
        allowLoopback: true,
      }),
    ).toBe(true);
  });

  it("never recovers to the page's own origin, even with allowLoopback (no self-loop)", () => {
    expect(
      isRecoverableRemoteBase({
        ...base,
        clientBaseUrl: "http://localhost:2138",
        allowLoopback: true,
      }),
    ).toBe(false);
  });
});
