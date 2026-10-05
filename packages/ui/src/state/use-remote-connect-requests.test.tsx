// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectRequestResult, dispatchConnectRequest } from "../events";
import { useRemoteConnectRequests } from "./use-remote-connect-requests";

const mocks = vi.hoisted(() => ({
  state: {
    completeFirstRun: vi.fn(),
    retryStartup: vi.fn(),
    setActionNotice: vi.fn(),
    setState: vi.fn(),
    uiLanguage: "en",
  },
  confirm: vi.fn(),
  adopt: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("./app-store", () => ({
  useAppSelectorShallow: (select: (state: typeof mocks.state) => unknown) =>
    select(mocks.state),
}));
vi.mock("../api/client", () => ({ client: {} }));
vi.mock("../utils/desktop-dialogs", () => ({
  confirmDesktopAction: mocks.confirm,
}));
vi.mock("../platform/browser-launch", () => ({
  applyLaunchConnection: mocks.adopt,
}));
vi.mock("../first-run/adopt-remote-first-run", () => ({
  clearPendingRemoteFirstRun: vi.fn(),
  completeRemoteAgentFirstRun: mocks.complete,
}));
vi.mock("../first-run/mobile-runtime-mode", async (original) => ({
  ...(await original<typeof import("../first-run/mobile-runtime-mode")>()),
  persistMobileRuntimeModeForServerTarget: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(false);
  mocks.complete.mockResolvedValue(undefined);
  mocks.adopt.mockImplementation(({ apiBase, token }) => ({ apiBase, token }));
});
afterEach(cleanup);

describe("remote connection ownership", () => {
  it.each([
    "https://agent.example",
    "https://127.agent.example",
    "http://0.0.0.0",
  ])("requires approval before adopting %s", async (gatewayUrl) => {
    renderHook(() => useRemoteConnectRequests());
    let outcome: ConnectRequestResult | undefined;
    await act(async () => {
      outcome = await dispatchConnectRequest({ gatewayUrl });
    });
    expect(outcome).toEqual({ status: "cancelled" });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.adopt).not.toHaveBeenCalled();
    expect(mocks.state.retryStartup).not.toHaveBeenCalled();
  });

  it("hands queued requests to the enabled owner exactly once", async () => {
    const { rerender } = renderHook(
      ({ enabled }) => useRemoteConnectRequests(enabled),
      { initialProps: { enabled: false } },
    );
    const result = dispatchConnectRequest({
      gatewayUrl: "http://127.0.0.2:2138",
      token: "agent-token",
      completeFirstRun: true,
    });
    expect(mocks.adopt).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await act(async () => {
      await result;
    });
    expect(await result).toEqual({ status: "connected" });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.adopt).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.state.setState).toHaveBeenCalledWith(
      "firstRunRemoteToken",
      "agent-token",
    );
    expect(mocks.state.retryStartup).toHaveBeenCalledOnce();
  });

  it("reports a failed first-run probe without restarting as connected", async () => {
    mocks.complete.mockRejectedValueOnce(new Error("Remote probe failed"));
    renderHook(() => useRemoteConnectRequests());
    let outcome: ConnectRequestResult | undefined;
    await act(async () => {
      outcome = await dispatchConnectRequest({
        gatewayUrl: "https://agent.example",
        skipConfirm: true,
        completeFirstRun: true,
      });
    });
    expect(outcome).toEqual({
      status: "failed",
      message: "Remote probe failed",
    });
    expect(mocks.state.setState).toHaveBeenCalledWith(
      "firstRunRemoteConnected",
      false,
    );
    expect(mocks.state.retryStartup).not.toHaveBeenCalled();
  });
});
