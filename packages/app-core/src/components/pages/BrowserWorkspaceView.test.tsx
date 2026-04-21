// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useAppMock, clientMock } = vi.hoisted(() => ({
  useAppMock: vi.fn(),
  clientMock: {
    fetch: vi.fn(),
    getBrowserWorkspace: vi.fn(),
    getWalletConfig: vi.fn(),
    openBrowserWorkspaceTab: vi.fn(),
    showBrowserWorkspaceTab: vi.fn(),
    navigateBrowserWorkspaceTab: vi.fn(),
    snapshotBrowserWorkspaceTab: vi.fn(),
    closeBrowserWorkspaceTab: vi.fn(),
  },
}));

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("./useBrowserWorkspaceWalletBridge", () => ({
  useBrowserWorkspaceWalletBridge: () => ({
    postBrowserWalletReady: vi.fn(),
  }),
}));

import { BrowserWorkspaceView } from "./BrowserWorkspaceView";

function buildUseAppState(overrides?: Record<string, unknown>) {
  return {
    activeConversationId: null,
    getStewardPending: vi.fn().mockResolvedValue([]),
    getStewardStatus: vi.fn().mockResolvedValue(null),
    setActionNotice: vi.fn(),
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
    walletAddresses: null,
    walletConfig: null,
    ...overrides,
  };
}

function buildPackageStatus() {
  return {
    extensionPath: "/tmp/lifeops-browser",
    chromeBuildPath: "/tmp/lifeops-browser/dist/chrome",
    chromePackagePath: null,
    safariWebExtensionPath: null,
    safariAppPath: null,
    safariPackagePath: null,
    releaseManifest: null,
  };
}

describe("BrowserWorkspaceView", () => {
  beforeEach(() => {
    useAppMock.mockReset();
    clientMock.fetch.mockReset();
    clientMock.getBrowserWorkspace.mockReset();
    clientMock.getWalletConfig.mockReset();
    clientMock.openBrowserWorkspaceTab.mockReset();
    clientMock.showBrowserWorkspaceTab.mockReset();
    clientMock.navigateBrowserWorkspaceTab.mockReset();
    clientMock.snapshotBrowserWorkspaceTab.mockReset();
    clientMock.closeBrowserWorkspaceTab.mockReset();

    useAppMock.mockReturnValue(buildUseAppState());
    clientMock.getBrowserWorkspace.mockResolvedValue({
      mode: "web",
      tabs: [],
    });
    clientMock.getWalletConfig.mockResolvedValue(null);
    clientMock.fetch.mockImplementation(async (path: string) => {
      if (path === "/api/lifeops/browser/companions") {
        return { companions: [] };
      }
      if (path === "/api/lifeops/browser/packages") {
        return { status: buildPackageStatus() };
      }
      throw new Error(`Unexpected client.fetch call: ${path}`);
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the LifeOps Browser install card in empty web mode", async () => {
    render(<BrowserWorkspaceView />);

    await screen.findByText("Use your real browser here");

    expect(screen.queryByText(/Embedded fallback only/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Install LifeOps Browser" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open extension folder" }),
    ).toBeTruthy();
  });

  it("opens the extension folder and Chrome extensions from the install card", async () => {
    const setActionNotice = vi.fn();
    useAppMock.mockReturnValue(buildUseAppState({ setActionNotice }));
    clientMock.fetch.mockImplementation(
      async (path: string, init?: RequestInit) => {
        if (path === "/api/lifeops/browser/companions") {
          return { companions: [] };
        }
        if (path === "/api/lifeops/browser/packages") {
          return { status: buildPackageStatus() };
        }
        if (path === "/api/lifeops/browser/packages/open-path") {
          return {
            path: "/tmp/lifeops-browser/dist/chrome",
            target: "chrome_build",
            revealOnly: true,
          };
        }
        if (path === "/api/lifeops/browser/packages/chrome/open-manager") {
          expect(init?.method).toBe("POST");
          return { browser: "chrome" };
        }
        throw new Error(`Unexpected client.fetch call: ${path}`);
      },
    );

    render(<BrowserWorkspaceView />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Install LifeOps Browser" }),
    );

    await waitFor(() => {
      expect(clientMock.fetch).toHaveBeenCalledWith(
        "/api/lifeops/browser/packages/open-path",
        expect.objectContaining({
          method: "POST",
        }),
      );
      expect(clientMock.fetch).toHaveBeenCalledWith(
        "/api/lifeops/browser/packages/chrome/open-manager",
        expect.objectContaining({
          method: "POST",
        }),
      );
      expect(setActionNotice).toHaveBeenCalledWith(
        expect.stringContaining("Click Load unpacked"),
        "success",
        6000,
      );
    });
  });
});
