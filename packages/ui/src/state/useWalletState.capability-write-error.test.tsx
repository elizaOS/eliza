// @vitest-environment jsdom
//
// Real error-path coverage for capability-toggle persistence in useWalletState
// (issue #12267): the optimistic local toggle is applied immediately, but the
// server `updateConfig` write used to be swallowed by `.catch(() => {})`, so a
// failed sync silently reverted on the next hydration. The write now logs at
// error while keeping the optimistic UI. Deterministic client + persistence
// mocks; logger spied to assert the failure surfaces.

import { logger } from "@elizaos/logger";
import { act, renderHook } from "@testing-library/react";
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
}));

vi.mock("../api", () => ({ client: mocks.client }));
vi.mock("./persistence", () => mocks.persistence);
vi.mock("../utils/desktop-dialogs", () => ({
  confirmDesktopAction: vi.fn(async () => true),
}));

import { useWalletState } from "./useWalletState";

const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

function renderWalletState() {
  return renderHook(() =>
    useWalletState({
      setActionNotice: vi.fn(),
      promptModal: vi.fn(async () => null),
      agentName: undefined,
      characterName: undefined,
      hydrateServerConfig: false,
    }),
  );
}

beforeEach(() => {
  mocks.client.updateConfig.mockReset();
  errorSpy.mockReset();
  mocks.persistence.saveWalletEnabled.mockReset();
});

describe("useWalletState — capability write failure surfaces", () => {
  it("logs when the server config write rejects but keeps the optimistic toggle", async () => {
    mocks.client.updateConfig.mockRejectedValue(new Error("network down"));
    const { result } = renderWalletState();

    await act(async () => {
      result.current.setWalletEnabled(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Optimistic local + localStorage update still applied.
    expect(result.current.state.walletEnabled).toBe(true);
    expect(mocks.persistence.saveWalletEnabled).toHaveBeenCalledWith(true);
    // The lost sync write is now observable rather than swallowed.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[1]).toContain(
      "failed to persist wallet capability toggle",
    );
  });

  it("does not log when the server config write succeeds", async () => {
    mocks.client.updateConfig.mockResolvedValue(undefined);
    const { result } = renderWalletState();

    await act(async () => {
      result.current.setWalletEnabled(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.walletEnabled).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
