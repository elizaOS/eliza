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
    setFirstRunLoading: vi.fn(),
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
    clientMock.getStatus.mockResolvedValue({
      state: "running",
      agentName: "Playwright Smoke",
      model: "ui-smoke",
      uptime: 1_000,
      startedAt: Date.now() - 1_000,
    });
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
      firstRun: {
        checked: true,
        complete: true,
        requiredGate: null,
      },
      remotes: {
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
    expect(clientMock.getStatus).toHaveBeenCalled();
    expect(deps.setAgentStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "running",
        agentName: "Eliza",
        port: 31337,
        startup: expect.objectContaining({ phase: "ready", attempt: 0 }),
      }),
    );
    expect(deps.setAgentStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "running",
        agentName: "Playwright Smoke",
        model: "ui-smoke",
      }),
    );
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
  });

  it("hydrates full status after desktop boot progress leaves the startup shell", async () => {
    clientMock.getBootProgress.mockResolvedValue({
      state: "running",
      phase: "running",
      lastError: null,
      pluginsLoaded: 22,
      pluginsFailed: 0,
      database: "ok",
      agentName: "Eliza",
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

    expect(clientMock.getStatus).toHaveBeenCalled();
    expect(deps.setAgentStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "running",
        agentName: "Eliza",
        port: 31337,
        startup: expect.objectContaining({ phase: "running", attempt: 0 }),
      }),
    );
    expect(deps.setAgentStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "running",
        agentName: "Playwright Smoke",
        model: "ui-smoke",
      }),
    );
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
  });

  it("still leaves startup when ready progress cannot hydrate full status", async () => {
    clientMock.getStatus.mockRejectedValue({ status: 404 });
    clientMock.getBootProgress.mockResolvedValue({
      state: "running",
      phase: "running",
      lastError: null,
      pluginsLoaded: 22,
      pluginsFailed: 0,
      database: "ok",
      agentName: "Eliza",
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

    expect(clientMock.getStatus).toHaveBeenCalled();
    expect(deps.setAgentStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "running",
        agentName: "Eliza",
        model: undefined,
      }),
    );
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
  });

  it("does not replace ready progress with stale non-running status", async () => {
    clientMock.getStatus.mockResolvedValue({
      state: "starting",
      agentName: "Eliza",
      model: undefined,
      uptime: 0,
      startedAt: null,
    });
    clientMock.getBootProgress.mockResolvedValue({
      state: "running",
      phase: "running",
      lastError: null,
      pluginsLoaded: 22,
      pluginsFailed: 0,
      database: "ok",
      agentName: "Eliza",
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

    expect(clientMock.getStatus).toHaveBeenCalled();
    expect(deps.setAgentStatus).toHaveBeenCalledTimes(1);
    expect(deps.setAgentStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "running",
        agentName: "Eliza",
        model: undefined,
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
    expect(deps.setFirstRunLoading).toHaveBeenCalledWith(false);
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

    expect(deps.setFirstRunLoading).toHaveBeenCalledWith(false);
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

    expect(deps.setFirstRunLoading).toHaveBeenCalledWith(false);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
    expect(deps.setStartupError).not.toHaveBeenCalled();
  });

  it("skips local agent startup for a cloud-hosted (cloud-managed) target", async () => {
    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
      "cloud-managed",
    );

    // No local boot/poll: never asks the bridge to start an agent and never
    // walks the launch/boot progress loop.
    expect(clientMock.startAgent).not.toHaveBeenCalled();
    expect(clientMock.getLaunchProgress).not.toHaveBeenCalled();
    expect(clientMock.getBootProgress).not.toHaveBeenCalled();
    // The already-running cloud agent is treated as ready and advanced.
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(deps.setFirstRunLoading).toHaveBeenCalledWith(false);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
    expect(deps.setStartupError).not.toHaveBeenCalled();
  });

  it("skips local agent startup for a cloud-hosted (remote-backend) target", async () => {
    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
      "remote-backend",
    );

    expect(clientMock.startAgent).not.toHaveBeenCalled();
    expect(clientMock.getLaunchProgress).not.toHaveBeenCalled();
    expect(clientMock.getBootProgress).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
  });

  it("still runs the full local boot/poll loop for an embedded-local target", async () => {
    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
      "embedded-local",
    );

    // Embedded-local walks the launch/boot/status path exactly as before.
    expect(clientMock.getLaunchProgress).toHaveBeenCalled();
    expect(clientMock.getBootProgress).toHaveBeenCalled();
    expect(clientMock.getStatus).toHaveBeenCalled();
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
  });
});
