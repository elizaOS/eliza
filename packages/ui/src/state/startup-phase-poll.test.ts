import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstRunOptions } from "../api";
import { scanProviderCredentials } from "../bridge";
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
  hasToken: vi.fn(),
  getBaseUrl: vi.fn(() => ""),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
}));

vi.mock("../api", () => ({
  client: clientMock,
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
    scanProviderCredentials: vi.fn(async () => []),
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
    setSetupStep: vi.fn(),
    setFirstRunRuntimeTarget: vi.fn(),
    setFirstRunCloudApiKey: vi.fn(),
    setFirstRunProvider: vi.fn(),
    setFirstRunVoiceProvider: vi.fn(),
    setFirstRunApiKey: vi.fn(),
    setFirstRunPrimaryModel: vi.fn(),
    setFirstRunOpenRouterModel: vi.fn(),
    setFirstRunRemoteConnected: vi.fn(),
    setFirstRunRemoteApiBase: vi.fn(),
    setFirstRunRemoteToken: vi.fn(),
    setFirstRunSmallModel: vi.fn(),
    setFirstRunLargeModel: vi.fn(),
    setFirstRunCloudProvisionedContainer: vi.fn(),
    setPairingEnabled: vi.fn(),
    setPairingExpiresAt: vi.fn(),
    applyDetectedProviders: vi.fn(),
    firstRunCompletionCommittedRef: { current: false },
    uiLanguage: "en",
  };
}

const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  vi.clearAllMocks();
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
  clientMock.hasToken.mockReturnValue(false);
  clientMock.getBaseUrl.mockReturnValue("");
});

afterEach(() => {
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

  it("bails without mutating state when cancelled during the provider-credential scan", async () => {
    // Second race window: scanProviderCredentials() is a separate in-flight
    // await after the Promise.all guard. An effect torn down while it runs must
    // not call applyFirstRunResumeFields / setSetupStep / dispatch BACKEND_REACHED.
    const deps = createDeps();
    const dispatch = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://localhost:2138", protocol: "http:" },
    };
    const cancelled = { current: false };
    // No firstRunProvider in config -> the scan path runs.
    clientMock.getConfig.mockResolvedValue({});
    (
      scanProviderCredentials as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async () => {
      cancelled.current = true; // effect cleanup raced the in-flight scan
      return [];
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

    expect(deps.setSetupStep).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
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
