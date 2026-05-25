import { beforeEach, describe, expect, it, vi } from "vitest";
import { startupReducer } from "./startup-coordinator";
import {
  recoverTerminalStartupError,
  type StartupCoordinatorDeps,
} from "./useStartupCoordinator";

const clientMock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getOnboardingStatus: vi.fn(),
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
    setOnboardingComplete: vi.fn(),
    onboardingCompletionCommittedRef: { current: false },
  } as unknown as StartupCoordinatorDeps;
}

describe("recoverTerminalStartupError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recovers a stale terminal startup error when the agent is running", async () => {
    const status = {
      state: "running",
      agentName: "Eliza",
      startup: { phase: "running", attempt: 0 },
    };
    clientMock.getStatus.mockResolvedValue(status);
    clientMock.getOnboardingStatus.mockResolvedValue({ complete: true });
    const deps = createDeps();
    const dispatch = vi.fn();

    await expect(
      recoverTerminalStartupError(deps, dispatch, { current: false }),
    ).resolves.toBe(true);

    expect(deps.setAgentStatus).toHaveBeenCalledWith(status);
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(deps.setStartupError).toHaveBeenCalledWith(null);
    expect(deps.setOnboardingLoading).toHaveBeenCalledWith(false);
    expect(deps.setOnboardingComplete).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
  });

  it("routes a recovered but incomplete install back to onboarding", async () => {
    clientMock.getStatus.mockResolvedValue({
      state: "running",
      agentName: "Eliza",
      startup: { phase: "running", attempt: 0 },
    });
    clientMock.getOnboardingStatus.mockResolvedValue({ complete: false });
    const deps = createDeps();
    const dispatch = vi.fn();

    await expect(
      recoverTerminalStartupError(deps, dispatch, { current: false }),
    ).resolves.toBe(true);

    expect(deps.setOnboardingComplete).toHaveBeenCalledWith(false);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      onboardingComplete: false,
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

    expect(clientMock.getOnboardingStatus).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(deps.setStartupError).not.toHaveBeenCalled();
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

  it("can return to onboarding when recovered backend is not yet onboarded", () => {
    expect(
      startupReducer(
        {
          phase: "error",
          reason: "backend-timeout",
          message: "transient",
          timedOut: true,
        },
        { type: "BACKEND_REACHED", onboardingComplete: false },
      ),
    ).toEqual({ phase: "onboarding-required", serverReachable: true });
  });
});
