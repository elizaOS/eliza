// @vitest-environment jsdom

/**
 * Exercises startup connect ownership and shell-view transitions through the
 * real hook while external network, persistence, and dialog boundaries remain
 * deterministic.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_EVENT, dispatchAppEvent } from "../events";

const harness = vi.hoisted(() => ({
  adoptRemote: vi.fn(async () => ({ alreadyComplete: false })),
  applyConnection: vi.fn(
    ({ apiBase, token }: { apiBase: string; token?: string | null }) => ({
      apiBase,
      token: token ?? null,
    }),
  ),
  confirm: vi.fn(async () => true),
  completeFirstRun: vi.fn(),
  dispatch: vi.fn(),
  ensureWorkspace: vi.fn(async () => {}),
  getFirstRunStatus: vi.fn(async () => ({
    complete: false,
    cloudProvisioned: false,
  })),
  persistRuntime: vi.fn(),
  reset: vi.fn(),
  retryStartup: vi.fn(),
  setActionNotice: vi.fn(),
  setState: vi.fn(),
  state: {} as Record<string, unknown>,
}));

vi.mock("../api", () => ({
  client: { getFirstRunStatus: harness.getFirstRunStatus },
}));
vi.mock("../first-run/adopt-remote-first-run", () => ({
  adoptRemoteAgentFirstRun: harness.adoptRemote,
}));
vi.mock("../first-run/ensure-store-build-workspace-folder", () => ({
  ensureStoreBuildWorkspaceFolder: harness.ensureWorkspace,
}));
vi.mock("../first-run/mobile-runtime-mode", () => ({
  persistMobileRuntimeModeForServerTarget: harness.persistRuntime,
}));
vi.mock("../platform", () => ({
  applyLaunchConnection: harness.applyConnection,
}));
vi.mock("../utils/desktop-dialogs", () => ({
  confirmDesktopAction: harness.confirm,
}));
vi.mock("./app-store", () => ({
  useAppSelectorShallow: (
    selector: (state: Record<string, unknown>) => unknown,
  ) => selector(harness.state),
}));

import { useStartupShellController } from "./use-startup-shell-controller";

function setPhase(
  phase: string,
  coordinatorState: Record<string, unknown> = { phase },
): void {
  harness.state.startupCoordinator = {
    phase,
    state: coordinatorState,
    dispatch: harness.dispatch,
    reset: harness.reset,
  };
}

function resetHarness(phase = "restoring-session"): void {
  vi.clearAllMocks();
  harness.applyConnection.mockImplementation(
    ({ apiBase, token }: { apiBase: string; token?: string | null }) => ({
      apiBase,
      token: token ?? null,
    }),
  );
  harness.adoptRemote.mockResolvedValue({ alreadyComplete: false });
  harness.confirm.mockResolvedValue(true);
  harness.getFirstRunStatus.mockResolvedValue({
    complete: false,
    cloudProvisioned: false,
  });
  Object.assign(harness.state, {
    startupError: null,
    firstRunCloudProvisionedContainer: false,
    completeFirstRun: harness.completeFirstRun,
    retryStartup: harness.retryStartup,
    setActionNotice: harness.setActionNotice,
    setState: harness.setState,
    t: (key: string) => `translated:${key}`,
    uiLanguage: "en",
  });
  setPhase(phase);
}

describe("useStartupShellController connect delivery", () => {
  beforeEach(() => {
    resetHarness();
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("leaves a cold-launch link unclaimed until force-fresh restore completes", async () => {
    const hook = renderHook(() => useStartupShellController());

    act(() => {
      dispatchAppEvent(CONNECT_EVENT, {
        gatewayUrl: "http://127.0.0.1:31337",
        completeFirstRun: true,
      });
    });
    expect(harness.applyConnection).not.toHaveBeenCalled();

    setPhase("pairing-required");
    hook.rerender();

    await waitFor(() => expect(harness.applyConnection).toHaveBeenCalled());
    await waitFor(() => expect(harness.completeFirstRun).toHaveBeenCalled());
    expect(harness.persistRuntime).toHaveBeenCalledWith("remote");
    expect(harness.adoptRemote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        apiBase: "http://127.0.0.1:31337",
        uiLanguage: "en",
      }),
    );
    expect(harness.completeFirstRun).toHaveBeenCalledTimes(1);
    expect(harness.dispatch).not.toHaveBeenCalledWith({
      type: "SWITCH_AGENT",
      target: "remote-backend",
    });
    expect(harness.reset).not.toHaveBeenCalled();
    expect(harness.completeFirstRun.mock.invocationCallOrder[0]).toBeLessThan(
      harness.retryStartup.mock.invocationCallOrder[0],
    );
    expect(harness.retryStartup).toHaveBeenCalledTimes(1);
    expect(harness.setActionNotice).toHaveBeenCalledWith(
      "Connected to remote backend.",
      "success",
      4200,
    );
    hook.unmount();
  });

  it("requires confirmation for a remote host and honors cancellation", async () => {
    resetHarness("pairing-required");
    harness.confirm.mockResolvedValue(false);
    const hook = renderHook(() => useStartupShellController());

    act(() => {
      dispatchAppEvent(CONNECT_EVENT, {
        gatewayUrl: "https://agent.example.com/path",
      });
    });

    await waitFor(() => expect(harness.confirm).toHaveBeenCalledTimes(1));
    expect(harness.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("agent.example.com"),
      }),
    );
    expect(harness.applyConnection).not.toHaveBeenCalled();
    expect(harness.setActionNotice).toHaveBeenCalledWith(
      "Connection request cancelled.",
      "info",
      4200,
    );
    hook.unmount();
  });

  it("surfaces a connection boundary failure", async () => {
    resetHarness("error");
    harness.applyConnection.mockImplementation(() => {
      throw new Error("remote rejected");
    });
    const hook = renderHook(() => useStartupShellController());

    act(() => {
      dispatchAppEvent(CONNECT_EVENT, {
        gatewayUrl: "https://agent.example.com",
        skipConfirm: true,
      });
    });

    await waitFor(() =>
      expect(harness.setActionNotice).toHaveBeenCalledWith(
        "remote rejected",
        "error",
        8000,
      ),
    );
    expect(harness.retryStartup).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("completes a normal remote adoption through the shared use case", async () => {
    resetHarness("pairing-required");
    const hook = renderHook(() => useStartupShellController());

    act(() => {
      dispatchAppEvent(CONNECT_EVENT, {
        gatewayUrl: "http://127.0.0.1:31337",
        completeFirstRun: true,
      });
    });

    await waitFor(() => expect(harness.completeFirstRun).toHaveBeenCalled());
    expect(harness.adoptRemote).toHaveBeenCalledTimes(1);
    expect(harness.completeFirstRun).toHaveBeenCalledTimes(1);
    expect(harness.dispatch).not.toHaveBeenCalledWith({
      type: "SWITCH_AGENT",
      target: "remote-backend",
    });
    expect(harness.reset).not.toHaveBeenCalled();
    expect(harness.completeFirstRun.mock.invocationCallOrder[0]).toBeLessThan(
      harness.retryStartup.mock.invocationCallOrder[0],
    );
    expect(harness.retryStartup).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("re-arms force-fresh when remote first-run adoption fails", async () => {
    resetHarness("pairing-required");
    harness.adoptRemote.mockRejectedValueOnce(new Error("remote write denied"));
    const hook = renderHook(() => useStartupShellController());

    act(() => {
      dispatchAppEvent(CONNECT_EVENT, {
        gatewayUrl: "http://127.0.0.1:31337",
        completeFirstRun: true,
      });
    });

    await waitFor(() =>
      expect(harness.setActionNotice).toHaveBeenCalledWith(
        "remote write denied",
        "error",
        8000,
      ),
    );
    expect(harness.completeFirstRun).not.toHaveBeenCalled();
    expect(harness.retryStartup).not.toHaveBeenCalled();
    hook.unmount();
  });
});

describe("useStartupShellController views", () => {
  beforeEach(() => {
    resetHarness();
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("maps loading, pairing, first-run, and coordinator errors", () => {
    const hook = renderHook(() => useStartupShellController());
    expect(hook.result.current.view).toEqual({
      kind: "loading",
      phase: "restoring-session",
      status: "translated:startupshell.Starting",
    });

    setPhase("starting-runtime");
    hook.rerender();
    expect(hook.result.current.view).toMatchObject({
      kind: "loading",
      status: "translated:startupshell.InitializingAgent",
    });

    setPhase("pairing-required");
    hook.rerender();
    expect(hook.result.current.view).toEqual({ kind: "pairing" });

    setPhase("first-run-required", {
      phase: "first-run-required",
      serverReachable: false,
    });
    hook.rerender();
    expect(hook.result.current.view).toEqual({ kind: "none" });

    setPhase("error", {
      phase: "error",
      reason: "backend-timeout",
      message: "backend did not answer",
    });
    hook.rerender();
    expect(hook.result.current.view).toEqual({
      kind: "error",
      error: {
        reason: "backend-timeout",
        message: "backend did not answer",
        phase: "starting-backend",
      },
    });
    hook.unmount();
  });

  it("renders bootstrap and commits its advance through the coordinator", async () => {
    resetHarness("first-run-required");
    harness.state.firstRunCloudProvisionedContainer = true;
    setPhase("first-run-required", {
      phase: "first-run-required",
      serverReachable: true,
    });
    harness.getFirstRunStatus.mockResolvedValue({
      complete: false,
      cloudProvisioned: true,
    });
    const hook = renderHook(() => useStartupShellController());

    expect(hook.result.current.view.kind).toBe("bootstrap");
    await waitFor(() =>
      expect(harness.getFirstRunStatus).toHaveBeenCalledTimes(1),
    );
    const view = hook.result.current.view;
    if (view.kind !== "bootstrap") throw new Error("bootstrap view expected");
    act(() => view.onAdvance());

    expect(harness.setState).toHaveBeenCalledWith("firstRunComplete", true);
    expect(harness.dispatch).toHaveBeenCalledWith({
      type: "FIRST_RUN_COMPLETE",
    });
    hook.unmount();
  });
});
