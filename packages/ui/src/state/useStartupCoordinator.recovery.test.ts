/**
 * Unit coverage for terminal-startup-error recovery via the startup reducer.
 * Deps injected against a mocked client, no live agent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startupReducer } from "./startup-coordinator";
import {
  recoverTerminalStartupError,
  type StartupCoordinatorDeps,
  surfaceUnexpectedStartupRunnerError,
} from "./useStartupCoordinator";

const clientMock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getFirstRunStatus: vi.fn(),
  getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
  listConversations: vi.fn(),
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
    setFirstRunComplete: vi.fn(),
    firstRunCompletionCommittedRef: { current: false },
  } as unknown as StartupCoordinatorDeps;
}

describe("recoverTerminalStartupError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.getBaseUrl.mockReturnValue("http://127.0.0.1:31337");
    clientMock.listConversations.mockResolvedValue([]);
  });

  it("recovers a stale terminal startup error when the agent is running", async () => {
    const status = {
      state: "running",
      agentName: "Eliza",
      startup: { phase: "running", attempt: 0 },
    };
    clientMock.getStatus.mockResolvedValue(status);
    clientMock.getFirstRunStatus.mockResolvedValue({ complete: true });
    const deps = createDeps();
    const dispatch = vi.fn();

    await expect(
      recoverTerminalStartupError(deps, dispatch, { current: false }),
    ).resolves.toBe(true);

    expect(deps.setAgentStatus).toHaveBeenCalledWith(status);
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(deps.setStartupError).toHaveBeenCalledWith(null);
    expect(deps.setFirstRunLoading).toHaveBeenCalledWith(false);
    expect(deps.setFirstRunComplete).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
  });

  it("routes a recovered but incomplete install back to first-run", async () => {
    clientMock.getStatus.mockResolvedValue({
      state: "running",
      agentName: "Eliza",
      startup: { phase: "running", attempt: 0 },
    });
    clientMock.getFirstRunStatus.mockResolvedValue({ complete: false });
    const deps = createDeps();
    const dispatch = vi.fn();

    await expect(
      recoverTerminalStartupError(deps, dispatch, { current: false }),
    ).resolves.toBe(true);

    expect(deps.setFirstRunComplete).toHaveBeenCalledWith(false);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
  });

  it("a rehydrated completion ref routes a fresh boot home even when the server still reports incomplete (#11506)", async () => {
    // A fresh process seeds `firstRunCompletionCommittedRef` from the durable
    // completion flag. If the freshly-booted agent's first-run status has not
    // caught up yet and transiently reports incomplete, the committed ref must
    // still route the boot home instead of re-showing onboarding.
    clientMock.getStatus.mockResolvedValue({
      state: "running",
      agentName: "Eliza",
      startup: { phase: "running", attempt: 0 },
    });
    clientMock.getFirstRunStatus.mockResolvedValue({ complete: false });
    const deps = createDeps();
    deps.firstRunCompletionCommittedRef.current = true;
    const dispatch = vi.fn();

    await expect(
      recoverTerminalStartupError(deps, dispatch, { current: false }),
    ).resolves.toBe(true);

    expect(deps.setFirstRunComplete).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
  });

  it("does not recover while the agent is still not running", async () => {
    clientMock.getStatus.mockResolvedValue({
      state: "starting",
      agentName: "Eliza",
    });
    const deps = createDeps();
    const dispatch = vi.fn();

    await expect(
      recoverTerminalStartupError(deps, dispatch, { current: false }),
    ).resolves.toBe(false);

    expect(clientMock.getFirstRunStatus).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(deps.setStartupError).not.toHaveBeenCalled();
  });

  it("keeps direct Cloud in the terminal Retry state while its real adapter is offline", async () => {
    clientMock.getBaseUrl.mockReturnValue(
      "https://cloud.eliza.app/api/v1/eliza/agents/personal%3Aowner",
    );
    clientMock.getStatus.mockResolvedValue({
      state: "running",
      agentName: "Eliza",
      startup: { phase: "running", attempt: 0 },
    });
    clientMock.getFirstRunStatus.mockResolvedValue({ complete: true });
    clientMock.listConversations.mockRejectedValue(new Error("offline"));
    const deps = createDeps();
    const dispatch = vi.fn();

    await expect(
      recoverTerminalStartupError(deps, dispatch, { current: false }),
    ).resolves.toBe(false);

    expect(clientMock.listConversations).toHaveBeenCalledTimes(1);
    expect(deps.setAgentStatus).not.toHaveBeenCalled();
    expect(deps.setConnected).not.toHaveBeenCalled();
    expect(deps.setStartupError).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("recovers direct Cloud only after the real adapter answers", async () => {
    clientMock.getBaseUrl.mockReturnValue(
      "https://cloud.eliza.app/api/v1/eliza/agents/personal%3Aowner",
    );
    clientMock.getStatus.mockResolvedValue({
      state: "running",
      agentName: "Eliza",
      startup: { phase: "running", attempt: 0 },
    });
    clientMock.getFirstRunStatus.mockResolvedValue({ complete: true });
    clientMock.listConversations.mockResolvedValue([{ id: "conversation-1" }]);
    const deps = createDeps();
    const dispatch = vi.fn();

    await expect(
      recoverTerminalStartupError(deps, dispatch, { current: false }),
    ).resolves.toBe(true);

    expect(clientMock.listConversations).toHaveBeenCalledTimes(1);
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
  });

  it("does not probe conversations for an ordinary runtime", async () => {
    clientMock.getStatus.mockResolvedValue({
      state: "running",
      agentName: "Eliza",
      startup: { phase: "running", attempt: 0 },
    });
    clientMock.getFirstRunStatus.mockResolvedValue({ complete: true });

    await recoverTerminalStartupError(createDeps(), vi.fn(), {
      current: false,
    });

    expect(clientMock.listConversations).not.toHaveBeenCalled();
  });

  it("does not mutate recovery state when cancellation arrives during the direct Cloud probe", async () => {
    clientMock.getBaseUrl.mockReturnValue(
      "https://cloud.eliza.app/api/v1/eliza/agents/personal%3Aowner",
    );
    clientMock.getStatus.mockResolvedValue({
      state: "running",
      agentName: "Eliza",
      startup: { phase: "running", attempt: 0 },
    });
    clientMock.getFirstRunStatus.mockResolvedValue({ complete: true });
    const cancelled = { current: false };
    clientMock.listConversations.mockImplementation(async () => {
      cancelled.current = true;
      return [];
    });
    const deps = createDeps();
    const dispatch = vi.fn();

    await expect(
      recoverTerminalStartupError(deps, dispatch, cancelled),
    ).resolves.toBe(false);

    expect(deps.setConnected).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("startupReducer stale error recovery transitions", () => {
  it("can leave error state once the agent is confirmed running", () => {
    expect(
      startupReducer(
        {
          phase: "error",
          reason: "agent-error",
          message: "transient",
          timedOut: false,
        },
        { type: "AGENT_RUNNING" },
      ),
    ).toEqual({ phase: "hydrating" });
  });

  it("can return to first-run when recovered backend is not yet configured", () => {
    expect(
      startupReducer(
        {
          phase: "error",
          reason: "backend-timeout",
          message: "transient",
          timedOut: true,
        },
        { type: "BACKEND_REACHED", firstRunComplete: false },
      ),
    ).toEqual({ phase: "first-run-required", serverReachable: true });
  });
});

describe("unexpected startup runner failures", () => {
  it.each(["session restoration", "backend connection"] as const)(
    "dispatches a visible AGENT_ERROR when %s rejects unexpectedly",
    (runner) => {
      const deps = createDeps();
      const dispatch = vi.fn();

      surfaceUnexpectedStartupRunnerError(
        runner,
        new Error("runner exploded"),
        deps,
        dispatch,
        { current: false },
      );

      expect(deps.setStartupError).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "agent-error",
          message: expect.stringContaining("runner exploded"),
        }),
      );
      expect(dispatch).toHaveBeenCalledWith({
        type: "AGENT_ERROR",
        message: expect.stringContaining("runner exploded"),
      });
    },
  );

  it("does not dispatch after the runner effect was cancelled", () => {
    const deps = createDeps();
    const dispatch = vi.fn();

    surfaceUnexpectedStartupRunnerError(
      "backend connection",
      new Error("late rejection"),
      deps,
      dispatch,
      { current: true },
    );

    expect(deps.setStartupError).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
