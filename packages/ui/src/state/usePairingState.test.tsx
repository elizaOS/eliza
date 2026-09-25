// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { usePairingState } from "./usePairingState";

const mocks = vi.hoisted(() => ({
  pair: vi.fn(),
  getBaseUrl: vi.fn(() => "http://10.0.2.2:31338"),
  setToken: vi.fn(),
  persist: vi.fn(),
  resume: vi.fn(),
}));
vi.mock("../api", () => ({ client: mocks }));
vi.mock("./active-server-credential", () => ({
  persistActiveServerCredential: mocks.persist,
}));
vi.mock("../first-run/adopt-remote-first-run", () => ({
  resumeRemoteFirstRunAfterPairing: mocks.resume,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pair.mockResolvedValue({ token: "test-session" });
  mocks.persist.mockResolvedValue(undefined);
  mocks.resume.mockRejectedValue(new Error("Host setup unavailable"));
});

it("retries setup after successful pairing without consuming the pairing code again", async () => {
  const { result } = renderHook(() => usePairingState(vi.fn()));
  act(() => result.current.setPairingCodeInput("TEST-CODE"));
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.persist).toHaveBeenCalledWith(
    "test-session",
    "http://10.0.2.2:31338",
  );
  expect(mocks.setToken).toHaveBeenCalledWith("test-session");
  expect(mocks.resume.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.setToken.mock.invocationCallOrder[0],
  );
  expect(result.current.state.pairingError).toBe(
    "Paired, but remote setup failed: Host setup unavailable",
  );
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.pair).toHaveBeenCalledTimes(1);
  expect(mocks.resume).toHaveBeenCalledTimes(2);
});

it("does not resume setup when the pairing code is rejected", async () => {
  mocks.pair.mockRejectedValue({ code: "PAIRING_INVALID" });
  const { result } = renderHook(() => usePairingState(vi.fn()));
  act(() => result.current.setPairingCodeInput("BAD-CODE"));
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(result.current.state.pairingError).toContain(
    "pairing code is invalid",
  );
});

it("refreshes the startup coordinator after the paired setup completes", async () => {
  mocks.resume.mockResolvedValue(undefined);
  const onPaired = vi.fn();
  const { result } = renderHook(() => usePairingState(onPaired));
  act(() => result.current.setPairingCodeInput("TEST-CODE"));
  await act(() => result.current.handlePairingSubmit());
  expect(onPaired).toHaveBeenCalledOnce();
  expect(onPaired.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.resume.mock.invocationCallOrder[0],
  );
  expect(result.current.state.pairingError).toBeNull();
});
