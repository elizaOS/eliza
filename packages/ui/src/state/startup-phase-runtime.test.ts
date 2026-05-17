import { beforeEach, describe, expect, it, vi } from "vitest";
import { runStartingRuntime } from "./startup-phase-runtime";

const clientMock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getAuthStatus: vi.fn(),
  hasToken: vi.fn(),
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
