// @vitest-environment jsdom

/**
 * Hook-level startup lifecycle coverage with deterministic phase boundaries.
 * The reducer and hook are real; external phase workers are controlled.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupEvent } from "./startup-coordinator";
import {
  type StartupCoordinatorDeps,
  useStartupCoordinator,
} from "./useStartupCoordinator";

const phaseMock = vi.hoisted(() => ({
  bindReady: vi.fn<(...args: unknown[]) => () => void>(() => vi.fn()),
  hydrate: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  poll: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  restore: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  start: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

const policyMock = vi.hoisted(() => ({
  enforceRam: vi.fn(),
  reconcileMode: vi.fn(),
}));

vi.mock("@elizaos/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../api", () => ({
  client: { getFirstRunStatus: vi.fn(), getStatus: vi.fn() },
}));
vi.mock("../bridge", () => ({ isElectrobunRuntime: () => false }));
vi.mock("../platform", () => ({
  isAndroid: false,
  isElizaOS: () => false,
  isIOS: false,
  isNative: false,
}));
vi.mock("../first-run/device-ram-gate", () => ({
  enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot: policyMock.enforceRam,
}));
vi.mock("../first-run/reconcile-mobile-runtime-mode", () => ({
  reconcilePersistedMobileRuntimeModeAtBoot: policyMock.reconcileMode,
}));
vi.mock("./startup-phase-hydrate", () => ({
  bindReadyPhase: phaseMock.bindReady,
  runHydrating: phaseMock.hydrate,
}));
vi.mock("./startup-phase-poll", () => ({
  runPollingBackend: phaseMock.poll,
}));
vi.mock("./startup-phase-restore", () => ({
  runRestoringSession: phaseMock.restore,
}));
vi.mock("./startup-phase-runtime", () => ({
  runStartingRuntime: phaseMock.start,
}));
vi.mock("./startup-telemetry", () => ({ markStartup: vi.fn() }));

function deps(): StartupCoordinatorDeps {
  return {
    setStartupPhase: vi.fn(),
  } as unknown as StartupCoordinatorDeps;
}

function dispatchFromCall(
  mock: ReturnType<typeof vi.fn>,
  callIndex = 0,
): (event: StartupEvent) => void {
  return mock.mock.calls[callIndex]?.[1] as (event: StartupEvent) => void;
}

describe("useStartupCoordinator lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    phaseMock.bindReady.mockImplementation(() => vi.fn());
    phaseMock.hydrate.mockResolvedValue(undefined);
    phaseMock.poll.mockResolvedValue(undefined);
    phaseMock.restore.mockResolvedValue(undefined);
    phaseMock.start.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("carries a first-run Cloud target through runtime start, hydration, and ready binding", async () => {
    phaseMock.restore.mockImplementation(async (...args: unknown[]) => {
      const dispatch = args[1] as (event: StartupEvent) => void;
      dispatch({ type: "NO_SESSION", hadPriorFirstRun: false });
    });
    const readyCleanup = vi.fn();
    phaseMock.bindReady.mockReturnValue(readyCleanup);
    const startupDeps = deps();
    const { result, unmount } = renderHook(() =>
      useStartupCoordinator(startupDeps),
    );

    await waitFor(() =>
      expect(result.current.phase).toBe("first-run-required"),
    );
    expect(policyMock.reconcileMode).toHaveBeenCalledOnce();
    expect(policyMock.enforceRam).toHaveBeenCalledOnce();

    act(() => result.current.firstRunComplete("cloud-managed"));
    await waitFor(() => expect(result.current.phase).toBe("starting-runtime"));
    expect(result.current.target).toBe("cloud-managed");
    expect(phaseMock.start.mock.calls[0]?.[6]).toBe("cloud-managed");

    act(() => dispatchFromCall(phaseMock.start)({ type: "AGENT_RUNNING" }));
    await waitFor(() => expect(result.current.phase).toBe("hydrating"));

    act(() =>
      dispatchFromCall(phaseMock.hydrate)({ type: "HYDRATION_COMPLETE" }),
    );
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.loading).toBe(false);
    expect(result.current.terminal).toBe(true);
    expect(phaseMock.bindReady).toHaveBeenCalledOnce();

    unmount();
    expect(readyCleanup).toHaveBeenCalledOnce();
  });

  it("restores a saved Cloud session through backend polling without losing its target", async () => {
    phaseMock.restore.mockImplementation(async (...args: unknown[]) => {
      const dispatch = args[1] as (event: StartupEvent) => void;
      dispatch({ type: "SESSION_RESTORED", target: "cloud-managed" });
    });
    const { result } = renderHook(() => useStartupCoordinator(deps()));

    await waitFor(() => expect(result.current.phase).toBe("polling-backend"));
    expect(result.current.target).toBe("cloud-managed");
    expect(phaseMock.poll).toHaveBeenCalledOnce();

    act(() =>
      dispatchFromCall(phaseMock.poll)({
        type: "BACKEND_REACHED",
        firstRunComplete: true,
      }),
    );
    await waitFor(() => expect(result.current.phase).toBe("starting-runtime"));
    expect(phaseMock.start.mock.calls[0]?.[6]).toBe("cloud-managed");
  });

  it("exposes reset, pairing, retry, and derived phase state without phase workers", async () => {
    const { result } = renderHook(() => useStartupCoordinator());
    expect(result.current).toMatchObject({
      phase: "restoring-session",
      legacyPhase: "starting-backend",
      loading: true,
      terminal: false,
      target: null,
    });

    act(() =>
      result.current.dispatch({ type: "NO_SESSION", hadPriorFirstRun: false }),
    );
    expect(result.current.phase).toBe("first-run-required");
    act(() => result.current.firstRunComplete("cloud-managed"));
    expect(result.current).toMatchObject({
      phase: "starting-runtime",
      target: "cloud-managed",
    });

    act(() => result.current.reset());
    expect(result.current.phase).toBe("restoring-session");
    act(() =>
      result.current.dispatch({
        type: "SESSION_RESTORED",
        target: "remote-backend",
      }),
    );
    await waitFor(() => expect(result.current.phase).toBe("polling-backend"));
    act(() => result.current.dispatch({ type: "BACKEND_AUTH_REQUIRED" }));
    expect(result.current.phase).toBe("pairing-required");
    act(() => result.current.pairingSuccess());
    expect(result.current.phase).toBe("restoring-session");

    act(() =>
      result.current.dispatch({ type: "NO_SESSION", hadPriorFirstRun: true }),
    );
    expect(result.current.terminal).toBe(true);
    expect(result.current.phase).toBe("error");
    act(() => result.current.retry());
    expect(result.current.phase).toBe("restoring-session");
  });
});
