// @vitest-environment jsdom
//
// Real error-path coverage for capability-toggle persistence in useWalletState
// (issue #12267): the optimistic local toggle applies immediately, and a failed
// server `updateConfig` write must surface — logged at error AND shown to the
// user via `setActionNotice` — never silently reverting on the next hydration.
// Deterministic client + persistence mocks; logger spied to assert surfacing.

import { logger } from "@elizaos/logger";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    updateConfig: vi.fn(),
    getConfig: vi.fn(async () => ({ ui: {} })),
  },
  persistence: {
    loadWalletEnabled: vi.fn(() => false),
    loadBrowserEnabled: vi.fn(() => false),
    loadComputerUseEnabled: vi.fn(() => false),
    saveWalletEnabled: vi.fn(),
    saveBrowserEnabled: vi.fn(),
    saveComputerUseEnabled: vi.fn(),
  },
  auth: { authenticated: true },
}));

vi.mock("../api", () => ({ client: mocks.client }));
vi.mock("./persistence", () => mocks.persistence);
vi.mock("../utils/desktop-dialogs", () => ({
  confirmDesktopAction: vi.fn(async () => true),
}));
vi.mock("../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => mocks.auth.authenticated,
}));

import { useWalletState } from "./useWalletState";

const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

type ActionNoticeFn = (
  text: string,
  tone?: "info" | "success" | "error",
  ttlMs?: number,
  once?: boolean,
  busy?: boolean,
) => void;

function renderWalletState(
  setActionNotice: ActionNoticeFn = vi.fn(),
  hydrateServerConfig = false,
) {
  return renderHook(() =>
    useWalletState({
      setActionNotice,
      promptModal: vi.fn(async () => null),
      agentName: undefined,
      characterName: undefined,
      hydrateServerConfig,
    }),
  );
}

beforeEach(() => {
  mocks.client.updateConfig.mockReset();
  mocks.client.getConfig.mockReset();
  mocks.client.getConfig.mockResolvedValue({ ui: {} });
  mocks.auth.authenticated = true;
  errorSpy.mockReset();
  mocks.persistence.saveWalletEnabled.mockReset();
});

describe("useWalletState — capability write failure surfaces", () => {
  it("waits for authentication before hydrating capability config", async () => {
    mocks.auth.authenticated = false;
    mocks.client.getConfig.mockResolvedValue({
      ui: { capabilities: { wallet: true } },
    });
    const { result, rerender } = renderWalletState(vi.fn(), true);

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.client.getConfig).not.toHaveBeenCalled();
    expect(result.current.state.walletEnabled).toBe(false);

    mocks.auth.authenticated = true;
    rerender();

    await waitFor(() => {
      expect(mocks.client.getConfig).toHaveBeenCalledTimes(1);
      expect(result.current.state.walletEnabled).toBe(true);
    });
    expect(mocks.persistence.saveWalletEnabled).toHaveBeenCalledWith(true);
  });

  it("logs and notifies the user when the server config write rejects, keeping the optimistic toggle", async () => {
    mocks.client.updateConfig.mockRejectedValue(new Error("network down"));
    const setActionNotice = vi.fn<ActionNoticeFn>();
    const { result } = renderWalletState(setActionNotice);

    await act(async () => {
      result.current.setWalletEnabled(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Optimistic local + localStorage update still applied.
    expect(result.current.state.walletEnabled).toBe(true);
    expect(mocks.persistence.saveWalletEnabled).toHaveBeenCalledWith(true);
    expect(mocks.client.updateConfig).toHaveBeenCalledWith({
      ui: { capabilities: { wallet: true } },
    });
    // The lost sync write is observable: structured log + user-visible notice.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[1]).toContain(
      "capability sync to server failed",
    );
    expect(setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("wallet"),
      "error",
    );
  });

  it("does not log or notify when the server config write succeeds", async () => {
    mocks.client.updateConfig.mockResolvedValue(undefined);
    const setActionNotice = vi.fn<ActionNoticeFn>();
    const { result } = renderWalletState(setActionNotice);

    await act(async () => {
      result.current.setWalletEnabled(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.walletEnabled).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(setActionNotice).not.toHaveBeenCalled();
  });
});
