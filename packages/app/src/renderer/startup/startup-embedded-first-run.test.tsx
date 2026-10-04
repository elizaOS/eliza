/**
 * Verifies desktop startup gating for an embedded agent whose first-run has
 * not completed (#30744): a restored target that resolves to the shell's own
 * embedded API is classified embedded-local, and a renderer-cached first-run
 * completion never presents the ready UI over a backend that reports
 * first-run incomplete with its runtime deferred. The startup poller and
 * reducer are real; the agent API is a deterministic test double, so this is
 * integration coverage rather than packaged-app evidence.
 */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  getFirstRunStatus: vi.fn(),
  getFirstRunOptions: vi.fn(),
  getConfig: vi.fn(),
  getStatus: vi.fn(),
  getLaunchProgress: vi.fn(),
  getBootProgress: vi.fn(),
  startAgent: vi.fn(),
  hasToken: vi.fn(() => false),
  getBaseUrl: vi.fn(() => "http://127.0.0.1:31338"),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
}));

vi.mock("../transports/android-native-agent-transport", () => ({
  getAndroidLocalAgentBootStateForUrl: vi.fn(async () => ({
    state: "unknown",
  })),
  requestAndroidLocalAgentStartForUrl: vi.fn(async () => false),
}));

vi.mock("@elizaos/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/ui")>()),
  client: clientMock,
  isAndroid: false,
  isIOS: false,
}));

import { getAgentReadyTimeoutMs } from "../../../../ui/src/state/agent-startup-timing";
import type { PersistedActiveServer } from "../../../../ui/src/state/persistence";
import {
  createDesktopPolicy,
  type StartupEvent,
  type StartupState,
  startupReducer,
} from "../../../../ui/src/state/startup-coordinator";
import {
  type PollingBackendDeps,
  runPollingBackend,
} from "./startup-phase-poll";
import {
  isDesktopEmbeddedApiBase,
  type RestoringSessionCtx,
  resolveDesktopRestoredTarget,
} from "./startup-phase-restore";
import {
  runStartingRuntime,
  type StartingRuntimeDeps,
} from "./startup-phase-runtime";

const EMBEDDED_BASE = "http://127.0.0.1:31338";

function createPollingDeps(committed: boolean): PollingBackendDeps {
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
    firstRunCompletionCommittedRef: { current: committed },
    uiLanguage: "en",
  };
}

async function pollOnce(
  deps: PollingBackendDeps,
  ctx: RestoringSessionCtx,
  target: "embedded-local" | "remote-backend",
): Promise<StartupEvent[]> {
  const events: StartupEvent[] = [];
  await runPollingBackend(
    deps,
    (event) => events.push(event),
    { ...createDesktopPolicy(), backendTimeoutMs: 5_000 },
    ctx,
    1,
    { current: 1 },
    { current: false },
    { current: null },
    target,
  );
  return events;
}

describe("desktop embedded first-run startup gating (#30744)", () => {
  const staleRemoteRecord: PersistedActiveServer = {
    id: "remote:loopback",
    kind: "remote",
    label: "Local agent",
    apiBase: "http://127.0.0.1:31337",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    clientMock.getBaseUrl.mockReturnValue(EMBEDDED_BASE);
    clientMock.hasToken.mockReturnValue(false);
    clientMock.getAuthStatus.mockResolvedValue({
      required: false,
      authenticated: false,
      pairingEnabled: false,
      expiresAt: null,
    });
    clientMock.getFirstRunStatus.mockResolvedValue({ complete: false });
    clientMock.getStatus.mockResolvedValue({ state: "not_started" });
    clientMock.getFirstRunOptions.mockResolvedValue({
      names: [],
      styles: [],
      providers: [],
      cloudProviders: [],
      models: { small: [], large: [] },
      inventoryProviders: [],
      sharedStyleRules: "",
    });
    clientMock.getConfig.mockResolvedValue({});
  });

  it("routes a cached completion over an unconfigured embedded backend to first-run, not ready", async () => {
    // Renderer storage still says onboarding completed and a restored record
    // exists, but the restore recorded no prior first-run for this backend.
    const deps = createPollingDeps(true);
    const events = await pollOnce(
      deps,
      {
        persistedActiveServer: staleRemoteRecord,
        restoredActiveServer: staleRemoteRecord,
        shouldPreserveCompletedFirstRun: false,
        hadPriorFirstRun: false,
      },
      "embedded-local",
    );

    expect(clientMock.getStatus).toHaveBeenCalled();
    expect(deps.firstRunCompletionCommittedRef.current).toBe(false);
    expect(deps.setFirstRunComplete).toHaveBeenLastCalledWith(false);
    expect(events).toEqual([
      { type: "BACKEND_REACHED", firstRunComplete: false },
    ]);
    const state = startupReducer(
      { phase: "polling-backend", target: "embedded-local", attempts: 0 },
      events[0] as StartupEvent,
    );
    expect(state).toMatchObject({
      phase: "first-run-required",
      serverReachable: true,
      target: "embedded-local",
    });
  });

  it("keeps a cached completion when the backend runtime is already running", async () => {
    clientMock.getStatus.mockResolvedValue({ state: "running" });
    const deps = createPollingDeps(true);
    const events = await pollOnce(
      deps,
      {
        persistedActiveServer: staleRemoteRecord,
        restoredActiveServer: staleRemoteRecord,
        shouldPreserveCompletedFirstRun: true,
        hadPriorFirstRun: false,
      },
      "embedded-local",
    );

    expect(deps.firstRunCompletionCommittedRef.current).toBe(true);
    expect(events).toEqual([
      { type: "BACKEND_REACHED", firstRunComplete: true },
    ]);
    let state: StartupState = startupReducer(
      { phase: "polling-backend", target: "embedded-local", attempts: 0 },
      events[0] as StartupEvent,
    );
    expect(state).toMatchObject({ phase: "starting-runtime" });
    state = startupReducer(state, { type: "AGENT_RUNNING" });
    expect(state.phase).toBe("hydrating");
  });

  it("classifies a restored remote record on the shell's embedded API as embedded-local", () => {
    expect(isDesktopEmbeddedApiBase(EMBEDDED_BASE, EMBEDDED_BASE)).toBe(true);
    expect(
      isDesktopEmbeddedApiBase("http://127.0.0.1:31337", EMBEDDED_BASE),
    ).toBe(false);
    expect(
      isDesktopEmbeddedApiBase("https://agent.example.com", EMBEDDED_BASE),
    ).toBe(false);
    expect(isDesktopEmbeddedApiBase(EMBEDDED_BASE, null)).toBe(false);

    const base = {
      serverKind: "remote" as const,
      clientBaseUrl: EMBEDDED_BASE,
      liveApiBase: EMBEDDED_BASE,
    };
    expect(
      resolveDesktopRestoredTarget({
        ...base,
        target: "remote-backend",
        shellRuntimeMode: "local",
      }),
    ).toBe("embedded-local");
    // An external-mode shell does not host the embedded agent.
    expect(
      resolveDesktopRestoredTarget({
        ...base,
        target: "remote-backend",
        shellRuntimeMode: "external",
      }),
    ).toBe("remote-backend");
    // Unknown shell mode (bridge timeout) keeps the persisted classification.
    expect(
      resolveDesktopRestoredTarget({
        ...base,
        target: "remote-backend",
        shellRuntimeMode: undefined,
      }),
    ).toBe("remote-backend");
    // A remote on another host is never reclassified.
    expect(
      resolveDesktopRestoredTarget({
        ...base,
        clientBaseUrl: "https://agent.example.com",
        target: "remote-backend",
        shellRuntimeMode: "local",
      }),
    ).toBe("remote-backend");
    // Existing external-mode downgrade of a loopback "local" record.
    expect(
      resolveDesktopRestoredTarget({
        ...base,
        serverKind: "local",
        target: "embedded-local",
        shellRuntimeMode: "external",
      }),
    ).toBe("remote-backend");
  });

  describe("starting-runtime for a remote-backend target", () => {
    function createRuntimeDeps(): StartingRuntimeDeps {
      return {
        setAgentStatus: vi.fn(),
        setConnected: vi.fn(),
        setStartupError: vi.fn(),
        setFirstRunLoading: vi.fn(),
        setFirstRunComplete: vi.fn(),
        setAuthRequired: vi.fn(),
        setPairingEnabled: vi.fn(),
        setPairingExpiresAt: vi.fn(),
        setPendingRestart: vi.fn(),
        setPendingRestartReasons: vi.fn(),
      };
    }

    async function runRemoteRuntime(
      deps: StartingRuntimeDeps,
    ): Promise<StartupEvent[]> {
      const events: StartupEvent[] = [];
      await runStartingRuntime(
        deps,
        (event) => events.push(event),
        1,
        { current: 1 },
        { current: false },
        { current: null },
        "remote-backend",
      );
      return events;
    }

    beforeEach(() => {
      clientMock.getLaunchProgress.mockResolvedValue(null);
      clientMock.getBootProgress.mockResolvedValue(null);
    });

    it("waits for a not-yet-booted backend runtime instead of declaring ready", async () => {
      clientMock.getStatus.mockResolvedValue({ state: "not_started" });
      clientMock.startAgent.mockResolvedValue({ state: "running" });
      const deps = createRuntimeDeps();

      const events = await runRemoteRuntime(deps);

      expect(clientMock.startAgent).toHaveBeenCalledTimes(1);
      expect(events).toEqual([{ type: "AGENT_RUNNING" }]);
    });

    it("surfaces a backend runtime boot failure instead of declaring ready", async () => {
      clientMock.getStatus.mockResolvedValue({
        state: "error",
        startup: { phase: "failed", attempt: 0, lastError: "db_unavailable" },
      });
      const deps = createRuntimeDeps();

      const events = await runRemoteRuntime(deps);

      expect(events).toEqual([
        { type: "AGENT_ERROR", message: "db_unavailable" },
      ]);
      expect(deps.setStartupError).toHaveBeenCalled();
    });

    it("retries a failed status probe before declaring a remote backend ready", async () => {
      clientMock.getStatus
        .mockRejectedValueOnce(new Error("Backend transport unavailable"))
        .mockResolvedValue({ state: "running" });
      const deps = createRuntimeDeps();

      const events = await runRemoteRuntime(deps);

      expect(clientMock.getStatus).toHaveBeenCalledTimes(2);
      expect(events).toEqual([{ type: "AGENT_RUNNING" }]);
      expect(deps.setAgentStatus).toHaveBeenCalledWith({ state: "running" });
    });

    it("keeps the ready path for a backend without a status endpoint", async () => {
      clientMock.getStatus.mockRejectedValue(
        Object.assign(new Error("Not Found"), {
          kind: "http",
          status: 404,
          path: "/api/status",
        }),
      );
      const deps = createRuntimeDeps();

      const events = await runRemoteRuntime(deps);

      expect(clientMock.getLaunchProgress).not.toHaveBeenCalled();
      expect(clientMock.startAgent).not.toHaveBeenCalled();
      expect(deps.setConnected).toHaveBeenCalledWith(true);
      expect(events).toEqual([{ type: "AGENT_RUNNING" }]);
    });

    it("times out an unavailable remote backend without presenting ready", async () => {
      vi.useFakeTimers();
      try {
        clientMock.getStatus.mockRejectedValue(
          new Error("Backend transport unavailable"),
        );
        const deps = createRuntimeDeps();
        const pending = runRemoteRuntime(deps);

        await vi.advanceTimersByTimeAsync(getAgentReadyTimeoutMs() + 1_000);
        const events = await pending;

        expect(events).toEqual([{ type: "AGENT_TIMEOUT" }]);
        expect(deps.setConnected).not.toHaveBeenCalledWith(true);
        expect(deps.setStartupError).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "agent-timeout" }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the immediate ready path for an already-running remote agent", async () => {
      clientMock.getStatus.mockResolvedValue({ state: "running" });
      const deps = createRuntimeDeps();

      const events = await runRemoteRuntime(deps);

      expect(clientMock.startAgent).not.toHaveBeenCalled();
      expect(clientMock.getLaunchProgress).not.toHaveBeenCalled();
      expect(events).toEqual([{ type: "AGENT_RUNNING" }]);
    });
  });

  describe("starting-runtime for the packaged embedded agent", () => {
    function createRuntimeDeps(): StartingRuntimeDeps {
      return {
        setAgentStatus: vi.fn(),
        setConnected: vi.fn(),
        setStartupError: vi.fn(),
        setFirstRunLoading: vi.fn(),
        setFirstRunComplete: vi.fn(),
        setAuthRequired: vi.fn(),
        setPairingEnabled: vi.fn(),
        setPairingExpiresAt: vi.fn(),
        setPendingRestart: vi.fn(),
        setPendingRestartReasons: vi.fn(),
      };
    }

    async function runEmbeddedRuntime(): Promise<StartupEvent[]> {
      const events: StartupEvent[] = [];
      await runStartingRuntime(
        createRuntimeDeps(),
        (event) => events.push(event),
        1,
        { current: 1 },
        { current: false },
        { current: null },
        "embedded-local",
      );
      return events;
    }

    // The app server host projects every serving phase as agent state
    // "running" but never reports the legacy "running" phase itself.
    it.each(["ready", "runtime-ready", "features-starting", "degraded"])(
      "declares ready when the shell launch snapshot reports runtime phase %s",
      async (runtimePhase) => {
        clientMock.getStatus.mockResolvedValue({ state: "running" });
        clientMock.getLaunchProgress.mockResolvedValue({
          phase: "agent-api-ready",
          agent: {
            state: "running",
            port: 31339,
            apiBase: "http://127.0.0.1:31339",
            startedAt: 1,
            error: null,
          },
          boot: { runtimePhase },
          auth: { checked: true, required: false, error: null },
          firstRun: { checked: true, complete: true, error: null },
          localModel: { backgroundDownloadQueued: false, blocking: false },
        });

        const events = await runEmbeddedRuntime();

        expect(clientMock.startAgent).not.toHaveBeenCalled();
        expect(events).toEqual([{ type: "AGENT_RUNNING" }]);
      },
    );

    it("declares ready from boot progress in the app server host's ready phase", async () => {
      clientMock.getStatus.mockResolvedValue({ state: "running" });
      clientMock.getLaunchProgress.mockResolvedValue(null);
      clientMock.getBootProgress.mockResolvedValue({
        state: "running",
        phase: "ready",
        port: 31339,
        startedAt: 1,
      });

      const events = await runEmbeddedRuntime();

      expect(events).toEqual([{ type: "AGENT_RUNNING" }]);
    });
  });
});
