import { beforeEach, describe, expect, it, vi } from "vitest";
import { runStartingRuntime } from "./startup-phase-runtime";

const clientMock = vi.hoisted(() => ({
  getLaunchProgress: vi.fn(),
  getBootProgress: vi.fn(),
  getStatus: vi.fn(),
  getAuthStatus: vi.fn(),
  hasToken: vi.fn(),
  startAgent: vi.fn(),
}));

vi.mock("../api", () => ({
  client: clientMock,
}));

function createDeps() {
  return {
    setAgentStatus: vi.fn(),
    setConnected: vi.fn(),
    setStartupError: vi.fn(),
    setOnboardingLoading: vi.fn(),
    setAuthRequired: vi.fn(),
    setPairingEnabled: vi.fn(),
    setPairingExpiresAt: vi.fn(),
    setPendingRestart: vi.fn(),
    setPendingRestartReasons: vi.fn(),
  };
}

describe("runStartingRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.getLaunchProgress.mockResolvedValue(null);
    clientMock.getBootProgress.mockResolvedValue(null);
  });

  it("uses desktop launch progress before boot progress", async () => {
    clientMock.getLaunchProgress.mockResolvedValue({
      phase: "ready",
      agent: {
        state: "running",
        port: 31337,
        apiBase: "http://127.0.0.1:31337",
        startedAt: Date.now() - 1_000,
        error: null,
      },
      boot: {
        runtimePhase: "running",
        pluginsLoaded: 22,
        pluginsFailed: 0,
        database: "ok",
      },
      auth: {
        checked: true,
        required: false,
      },
      onboarding: {
        checked: true,
        complete: true,
        requiredGate: null,
      },
      satellites: {
        seeded: true,
        requiredStarted: true,
        errors: [],
      },
      localModel: {
        backgroundDownloadQueued: false,
        blocking: false,
      },
      diagnostics: {
        logPath: "/tmp/agent.log",
        statusPath: "/tmp/status.json",
      },
      recovery: {
        canRetry: true,
        canOpenLogs: true,
        canCreateBugReport: true,
      },
      updatedAt: new Date().toISOString(),
    });

    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clientMock.getBootProgress).not.toHaveBeenCalled();
    expect(clientMock.getStatus).not.toHaveBeenCalled();
    expect(deps.setAgentStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "running",
        agentName: "Eliza",
        port: 31337,
        startup: expect.objectContaining({ phase: "ready", attempt: 0 }),
      }),
    );
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
  });

  it("uses desktop boot progress to leave the startup shell without /api/status", async () => {
    clientMock.getBootProgress.mockResolvedValue({
      state: "running",
      phase: "running",
      lastError: null,
      pluginsLoaded: 22,
      pluginsFailed: 0,
      database: "ok",
      agentName: "Milady",
      port: 31337,
      startedAt: Date.now() - 1_000,
      updatedAt: new Date().toISOString(),
    });

    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(clientMock.getStatus).not.toHaveBeenCalled();
    expect(deps.setAgentStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "running",
        agentName: "Milady",
        port: 31337,
        startup: expect.objectContaining({ phase: "running", attempt: 0 }),
      }),
    );
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
  });

  it("routes tokenless 401s to pairing instead of retrying until timeout", async () => {
    clientMock.getStatus.mockRejectedValue({ status: 401 });
    clientMock.getAuthStatus.mockResolvedValue({
      required: true,
      pairingEnabled: true,
      expiresAt: 1234,
    });
    clientMock.hasToken.mockReturnValue(false);

    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(deps.setAuthRequired).toHaveBeenCalledWith(true);
    expect(deps.setPairingEnabled).toHaveBeenCalledWith(true);
    expect(deps.setPairingExpiresAt).toHaveBeenCalledWith(1234);
    expect(deps.setOnboardingLoading).toHaveBeenCalledWith(false);
    expect(dispatch).toHaveBeenCalledWith({ type: "BACKEND_AUTH_REQUIRED" });
    expect(deps.setStartupError).not.toHaveBeenCalled();
  });

  it("advances paired bearer sessions to the auth gate after endpoint 401s", async () => {
    clientMock.getStatus.mockRejectedValue({ status: 401 });
    clientMock.getAuthStatus.mockResolvedValue({
      required: false,
      authenticated: true,
      pairingEnabled: true,
      expiresAt: 1234,
    });
    clientMock.hasToken.mockReturnValue(true);

    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(deps.setOnboardingLoading).toHaveBeenCalledWith(false);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
    expect(deps.setStartupError).not.toHaveBeenCalled();
  });

  it("advances remote password setup blockers without accepting every required auth status", async () => {
    clientMock.getStatus.mockRejectedValue({ status: 401 });
    clientMock.getAuthStatus.mockResolvedValue({
      required: true,
      authenticated: false,
      loginRequired: true,
      passwordConfigured: false,
      pairingEnabled: true,
      expiresAt: 1234,
    });
    clientMock.hasToken.mockReturnValue(true);

    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(deps.setOnboardingLoading).toHaveBeenCalledWith(false);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
    expect(deps.setStartupError).not.toHaveBeenCalled();
  });
});
