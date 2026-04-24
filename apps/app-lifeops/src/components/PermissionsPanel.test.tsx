// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  getLifeOpsFullDiskAccessStatusMock,
  getPermissionsMock,
  openExternalUrlMock,
  openPermissionSettingsMock,
  requestPermissionMock,
} = vi.hoisted(() => ({
  getLifeOpsFullDiskAccessStatusMock: vi.fn(),
  getPermissionsMock: vi.fn(),
  openExternalUrlMock: vi.fn(),
  openPermissionSettingsMock: vi.fn(),
  requestPermissionMock: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({
  Button: "button",
  openExternalUrl: openExternalUrlMock,
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getLifeOpsFullDiskAccessStatus: getLifeOpsFullDiskAccessStatusMock,
    getPermissions: getPermissionsMock,
    openPermissionSettings: openPermissionSettingsMock,
    requestPermission: requestPermissionMock,
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
  getPermissionsMock.mockReset();
  openExternalUrlMock.mockReset();
  openPermissionSettingsMock.mockReset();
  requestPermissionMock.mockReset();
  setUserAgent(originalUserAgent);
});

describe("PermissionsPanel", () => {
  it("shows macOS automation permissions and guides to the first missing privacy pane", async () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)");
    getLifeOpsFullDiskAccessStatusMock.mockResolvedValue({
      status: "revoked",
      checkedAt: "2026-04-23T12:00:00.000Z",
      chatDbPath: "/Users/test/Library/Messages/chat.db",
      reason:
        "Full Disk Access is required to read chat.db. Grant it to the app running Milady, such as Milady.app, Terminal, iTerm, or Cursor, then relaunch.",
    });
    getPermissionsMock.mockResolvedValue({
      accessibility: {
        id: "accessibility",
        status: "not-determined",
        canRequest: true,
        lastChecked: Date.now(),
      },
      "screen-recording": {
        id: "screen-recording",
        status: "denied",
        canRequest: false,
        lastChecked: Date.now(),
      },
    });
    requestPermissionMock.mockResolvedValue({
      id: "accessibility",
      status: "denied",
      canRequest: false,
      lastChecked: Date.now(),
    });

    render(<PermissionsPanel />);

    expect(await screen.findByText("Mac Permissions")).toBeTruthy();
    expect(screen.getByText("Accessibility")).toBeTruthy();
    expect(screen.getByText("Screen Recording")).toBeTruthy();
    expect(screen.getByText("Full Disk Access")).toBeTruthy();
    expect(
      screen.getByText(
        "Allows Milady to focus windows, click, type, and guide real browser or desktop actions.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Notifications")).toBeNull();
    expect(screen.queryByText("Microphone")).toBeNull();

    expect(await screen.findByText("Full Disk Access revoked")).toBeTruthy();
    expect(
      screen.getByText(
        "Full Disk Access is required to read chat.db. Grant it to the app running Milady, such as Milady.app, Terminal, iTerm, or Cursor, then relaunch.",
      ),
    ).toBeTruthy();
    expect(getLifeOpsFullDiskAccessStatusMock).toHaveBeenCalledOnce();
    expect(getPermissionsMock).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByText("Start Mac Permission Setup"));

    await waitFor(() => {
      expect(requestPermissionMock).toHaveBeenCalledWith("accessibility");
    });
  });
});
