// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getLifeOpsFullDiskAccessStatusMock } = vi.hoisted(() => ({
  getLifeOpsFullDiskAccessStatusMock: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({
  Button: "button",
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getLifeOpsFullDiskAccessStatus: getLifeOpsFullDiskAccessStatusMock,
  },
}));

import { PermissionsPanel } from "./PermissionsPanel";

const originalUserAgent = window.navigator.userAgent;

function setUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}

afterEach(() => {
  cleanup();
  getLifeOpsFullDiskAccessStatusMock.mockReset();
  setUserAgent(originalUserAgent);
});

describe("PermissionsPanel", () => {
  it("shows only the macOS full disk access entry and clarifies which app needs access", async () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)");
    getLifeOpsFullDiskAccessStatusMock.mockResolvedValue({
      status: "revoked",
      checkedAt: "2026-04-23T12:00:00.000Z",
      chatDbPath: "/Users/test/Library/Messages/chat.db",
      reason:
        "Full Disk Access is required to read chat.db. Grant it to the app running Milady, such as Milady.app, Terminal, iTerm, or Cursor, then relaunch.",
    });

    render(<PermissionsPanel />);

    expect(screen.getByText("Full Disk Access")).toBeTruthy();
    expect(
      screen.getByText(
        "Read iMessage chat.db for wake detection. Grant Full Disk Access to the app running Milady: usually Milady.app, or Terminal, iTerm, or Cursor in local dev.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Accessibility")).toBeNull();
    expect(screen.queryByText("Screen Recording")).toBeNull();
    expect(screen.queryByText("Notifications")).toBeNull();
    expect(screen.queryByText("Microphone")).toBeNull();

    expect(await screen.findByText("Full Disk Access revoked")).toBeTruthy();
    expect(
      screen.getByText(
        "Full Disk Access is required to read chat.db. Grant it to the app running Milady, such as Milady.app, Terminal, iTerm, or Cursor, then relaunch.",
      ),
    ).toBeTruthy();
    expect(getLifeOpsFullDiskAccessStatusMock).toHaveBeenCalledOnce();
  });
});
