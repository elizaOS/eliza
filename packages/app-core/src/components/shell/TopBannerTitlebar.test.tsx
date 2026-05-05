// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useAppMock } = vi.hoisted(() => ({
  useAppMock: vi.fn(),
}));

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

import { ConnectionFailedBanner } from "./ConnectionFailedBanner";
import { SystemWarningBanner } from "./SystemWarningBanner";

function buildUseAppState(overrides: Record<string, unknown> = {}) {
  return {
    backendConnection: {
      state: "connected",
      reconnectAttempt: 0,
      maxReconnectAttempts: 15,
      showDisconnectedUI: false,
    },
    backendDisconnectedBannerDismissed: false,
    dismissBackendDisconnectedBanner: vi.fn(),
    dismissSystemWarning: vi.fn(),
    retryBackendConnection: vi.fn(),
    systemWarnings: [],
    t: (key: string) => key,
    ...overrides,
  };
}

describe("top shell banners", () => {
  beforeEach(() => {
    useAppMock.mockReset();
    useAppMock.mockReturnValue(buildUseAppState());
  });

  afterEach(() => {
    cleanup();
  });

  it("marks the reconnecting banner for macOS titlebar inset padding", () => {
    useAppMock.mockReturnValue(
      buildUseAppState({
        backendConnection: {
          state: "reconnecting",
          reconnectAttempt: 1,
          maxReconnectAttempts: 15,
          showDisconnectedUI: false,
        },
      }),
    );

    render(<ConnectionFailedBanner />);

    expect(
      screen.getByRole("status").getAttribute("data-window-titlebar-banner"),
    ).toBe("true");
  });

  it("marks system warning banners for macOS titlebar inset padding", () => {
    useAppMock.mockReturnValue(
      buildUseAppState({
        systemWarnings: ["Reconnecting... (attempt 1/15)"],
      }),
    );

    render(<SystemWarningBanner />);

    expect(
      screen.getByRole("alert").getAttribute("data-window-titlebar-banner"),
    ).toBe("true");
  });
});
