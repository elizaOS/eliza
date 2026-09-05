/**
 * Covers the canonical desktop-only Settings leaf against a mocked native RPC
 * boundary, including initial authority loading and rejected mutation rollback.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import { DesktopIntegrationSection } from "./DesktopIntegrationSection";

const bridge = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: null, agentProps: {} }),
}));

vi.mock("../../bridge", () => ({
  invokeDesktopBridgeRequest: bridge.request,
}));

function seedState() {
  __setAppValueForTests({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  } as never);
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.clearAllMocks();
});

describe("DesktopIntegrationSection", () => {
  it("waits for the native value before enabling launch at sign-in", async () => {
    let resolveRead:
      | ((value: { enabled: boolean; openAsHidden: boolean }) => void)
      | undefined;
    bridge.request.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    seedState();

    render(<DesktopIntegrationSection />);
    const toggle = screen.getByTestId<HTMLButtonElement>(
      "desktop-launch-at-login",
    );
    expect(toggle.disabled).toBe(true);

    resolveRead?.({ enabled: true, openAsHidden: false });
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("data-state")).toBe("checked");
  });

  it("reverts a rejected native mutation and shows the failure", async () => {
    bridge.request
      .mockResolvedValueOnce({ enabled: false, openAsHidden: false })
      .mockRejectedValueOnce(new Error("Desktop service unavailable"));
    seedState();

    render(<DesktopIntegrationSection />);
    const toggle = screen.getByTestId<HTMLButtonElement>(
      "desktop-launch-at-login",
    );
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute("data-state")).toBe("unchecked");
      expect(screen.getByText("Desktop service unavailable")).toBeTruthy();
      expect(toggle.disabled).toBe(false);
    });
    expect(bridge.request).toHaveBeenLastCalledWith({
      rpcMethod: "desktopSetAutoLaunch",
      ipcChannel: "desktop:setAutoLaunch",
      params: { enabled: true, openAsHidden: false },
    });
  });

  it("keeps launch at sign-in unavailable when the native status method is missing", async () => {
    bridge.request.mockResolvedValueOnce(null);
    seedState();

    render(<DesktopIntegrationSection />);

    const toggle = screen.getByTestId<HTMLButtonElement>(
      "desktop-launch-at-login",
    );
    await waitFor(() => {
      expect(toggle.disabled).toBe(true);
      expect(
        screen.getByText("Unable to read the desktop setting."),
      ).toBeTruthy();
    });
  });

  it("reverts when the native setter returns no acknowledgement", async () => {
    bridge.request
      .mockResolvedValueOnce({ enabled: false, openAsHidden: false })
      .mockResolvedValueOnce(null);
    seedState();

    render(<DesktopIntegrationSection />);
    const toggle = screen.getByTestId<HTMLButtonElement>(
      "desktop-launch-at-login",
    );
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute("data-state")).toBe("unchecked");
      expect(
        screen.getByText("Unable to update the desktop setting."),
      ).toBeTruthy();
    });
  });

  it("serializes launch mutations triggered before React rerenders", async () => {
    let resolveMutation: (() => void) | undefined;
    bridge.request
      .mockResolvedValueOnce({ enabled: false, openAsHidden: false })
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveMutation = resolve;
        }),
      );
    seedState();

    render(<DesktopIntegrationSection />);
    const toggle = screen.getByTestId<HTMLButtonElement>(
      "desktop-launch-at-login",
    );
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(bridge.request).toHaveBeenCalledTimes(2);
    resolveMutation?.();
    await waitFor(() => expect(toggle.disabled).toBe(false));
  });
});
