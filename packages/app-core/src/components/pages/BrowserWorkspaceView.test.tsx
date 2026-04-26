// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createClientMock() {
  return {
    fetch: vi.fn(),
    getBrowserWorkspace: vi.fn(),
    getWalletConfig: vi.fn(),
    openBrowserWorkspaceTab: vi.fn(),
    showBrowserWorkspaceTab: vi.fn(),
    navigateBrowserWorkspaceTab: vi.fn(),
    snapshotBrowserWorkspaceTab: vi.fn(),
    closeBrowserWorkspaceTab: vi.fn(),
  };
}

var useAppMock = vi.fn();
var clientMock: ReturnType<typeof createClientMock> | undefined;

function getClientMock() {
  if (!clientMock) {
    clientMock = createClientMock();
  }
  return clientMock;
}

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../api", () => {
  const client = getClientMock();
  return { client };
});

vi.mock("./useBrowserWorkspaceWalletBridge", () => ({
  useBrowserWorkspaceWalletBridge: () => ({
    postBrowserWalletReady: vi.fn(),
  }),
}));

vi.mock("../workspace/AppWorkspaceChrome.js", () => ({
  AppWorkspaceChrome: ({ main }: { main: ReactNode }) => (
    <div data-testid="browser-workspace-chrome">{main}</div>
  ),
}));

import { BrowserWorkspaceView } from "./BrowserWorkspaceView";

function buildUseAppState(overrides?: Record<string, unknown>) {
  return {
    activeConversationId: null,
    getStewardPending: vi.fn().mockResolvedValue([]),
    getStewardStatus: vi.fn().mockResolvedValue(null),
    plugins: [
      {
        id: "browser-bridge",
        name: "Agent Browser Bridge",
        npmName: "@elizaos/plugin-browser-bridge",
      },
    ],
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
    extensionPath: "/tmp/browser-bridge",
    chromeBuildPath: "/tmp/browser-bridge/dist/chrome",
    chromePackagePath: null,
    safariWebExtensionPath: null,
    safariAppPath: null,
    safariPackagePath: null,
    releaseManifest: null,
  };
}

describe("BrowserWorkspaceView", () => {
  beforeEach(() => {
    const mockClient = getClientMock();
    useAppMock.mockReset();
    mockClient.fetch.mockReset();
    mockClient.getBrowserWorkspace.mockReset();
    mockClient.getWalletConfig.mockReset();
    mockClient.openBrowserWorkspaceTab.mockReset();
    mockClient.showBrowserWorkspaceTab.mockReset();
    mockClient.navigateBrowserWorkspaceTab.mockReset();
    mockClient.snapshotBrowserWorkspaceTab.mockReset();
    mockClient.closeBrowserWorkspaceTab.mockReset();

    useAppMock.mockReturnValue(buildUseAppState());
    mockClient.getBrowserWorkspace.mockResolvedValue({
      mode: "web",
      tabs: [],
    });
    mockClient.getWalletConfig.mockResolvedValue(null);
    mockClient.fetch.mockImplementation(async (path: string) => {
      if (path === "/api/browser-bridge/companions") {
        return { companions: [] };
      }
      if (path === "/api/browser-bridge/packages") {
        return { status: buildPackageStatus() };
      }
      throw new Error(`Unexpected client.fetch call: ${path}`);
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the Agent Browser Bridge install card in empty web mode", async () => {
    render(<BrowserWorkspaceView />);

    await screen.findByText(/The agent can drive your real Chrome tabs/i);

    expect(screen.queryByText(/Embedded fallback only/i)).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Install Agent Browser Bridge" })
        .length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "Open extension folder" }).length,
    ).toBeGreaterThan(0);
  });

  it("opens the extension folder and Chrome extensions from the install card", async () => {
    const mockClient = getClientMock();
    const setActionNotice = vi.fn();
    useAppMock.mockReturnValue(buildUseAppState({ setActionNotice }));
    mockClient.fetch.mockImplementation(
      async (path: string, init?: RequestInit) => {
        if (path === "/api/browser-bridge/companions") {
          return { companions: [] };
        }
        if (path === "/api/browser-bridge/packages") {
          return { status: buildPackageStatus() };
        }
        if (path === "/api/browser-bridge/packages/open-path") {
          return {
            path: "/tmp/browser-bridge/dist/chrome",
            target: "chrome_build",
            revealOnly: true,
          };
        }
        if (path === "/api/browser-bridge/packages/chrome/open-manager") {
          expect(init?.method).toBe("POST");
          return { browser: "chrome" };
        }
        throw new Error(`Unexpected client.fetch call: ${path}`);
      },
    );

    render(<BrowserWorkspaceView />);

    const installButtons = await screen.findAllByRole("button", {
      name: "Install Agent Browser Bridge",
    });
    fireEvent.click(installButtons[0]);

    await waitFor(() => {
      expect(mockClient.fetch).toHaveBeenCalledWith(
        "/api/browser-bridge/packages/open-path",
        expect.objectContaining({
          method: "POST",
        }),
      );
      expect(mockClient.fetch).toHaveBeenCalledWith(
        "/api/browser-bridge/packages/chrome/open-manager",
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

  it("skips browser-bridge requests when the plugin is unavailable", async () => {
    const mockClient = getClientMock();
    useAppMock.mockReturnValue(buildUseAppState({ plugins: [] }));

    render(<BrowserWorkspaceView />);

    await waitFor(() => {
      expect(
        screen.queryByText(/The agent can drive your real Chrome tabs/i),
      ).toBeNull();
    });
    expect(mockClient.fetch).not.toHaveBeenCalledWith(
      "/api/browser-bridge/companions",
    );
    expect(mockClient.fetch).not.toHaveBeenCalledWith(
      "/api/browser-bridge/packages",
    );
  });

  it("locks internal tabs so the URL cannot be edited and the tab cannot be closed", async () => {
    const mockClient = getClientMock();
    mockClient.getBrowserWorkspace.mockResolvedValue({
      mode: "web",
      tabs: [
        {
          id: "discord-internal",
          title: "Discord",
          url: "https://discord.com/channels/@me",
          partition: "lifeops-discord-agent-1-owner",
          kind: "internal",
          visible: true,
          createdAt: "2026-04-23T00:00:00.000Z",
          updatedAt: "2026-04-23T00:00:00.000Z",
          lastFocusedAt: "2026-04-23T00:00:00.000Z",
        },
      ],
    });

    render(<BrowserWorkspaceView />);

    const addressInput = await screen.findByDisplayValue(
      "https://discord.com/channels/@me",
    );
    await waitFor(() => {
      expect((addressInput as HTMLInputElement).disabled).toBe(true);
    });
    expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
    expect(
      screen.queryByText(/Internal.*discord\.com\/channels\/@me/i),
    ).not.toBeNull();
  });

  it("does not render Discord inside the web iframe fallback", async () => {
    clientMock?.getBrowserWorkspace.mockResolvedValue({
      mode: "web",
      tabs: [
        {
          id: "discord-web",
          title: "Discord",
          url: "https://discord.com/channels/@me",
          partition: "persist:eliza-browser",
          visible: true,
          createdAt: "2026-04-23T00:00:00.000Z",
          updatedAt: "2026-04-23T00:00:00.000Z",
          lastFocusedAt: "2026-04-23T00:00:00.000Z",
        },
      ],
    });

    const { container } = render(<BrowserWorkspaceView />);

    await screen.findByText(/Discord blocks embedded browser frames/i);
    expect(container.querySelector('iframe[title="Discord"]')).toBeNull();
  });

  it("renders user, agent, and app tab sections", async () => {
    const mockClient = getClientMock();
    mockClient.getBrowserWorkspace.mockResolvedValue({
      mode: "web",
      tabs: [
        {
          id: "user-tab",
          title: "milady.ai",
          url: "https://milady.ai/",
          partition: "persist:eliza-browser",
          visible: true,
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          lastFocusedAt: "2026-04-20T00:00:00.000Z",
        },
        {
          id: "agent-tab",
          title: "discord.com",
          url: "https://discord.com/",
          partition: "persist:eliza-browser-agent",
          visible: false,
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          lastFocusedAt: null,
        },
        {
          id: "app-tab",
          title: "pump.fun",
          url: "https://pump.fun/",
          partition: "persist:eliza-browser-app",
          visible: false,
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          lastFocusedAt: null,
        },
      ],
    });

    render(<BrowserWorkspaceView />);

    await screen.findByText("User Tabs");
    expect(screen.getByText("Agent Tabs")).toBeDefined();
    expect(screen.getByText("App Tabs")).toBeDefined();
    expect(screen.getByRole("tab", { name: /milady\.ai/i })).toBeDefined();
    expect(screen.getByRole("tab", { name: /discord\.com/i })).toBeDefined();
    expect(screen.getByRole("tab", { name: /pump\.fun/i })).toBeDefined();
    expect(screen.getByRole("button", { name: "Go" })).toBeDefined();
  });

  it("navigates the selected tab from the address bar go button", async () => {
    const mockClient = getClientMock();
    const initialTab = {
      id: "user-tab",
      title: "milady.ai",
      url: "https://milady.ai/",
      partition: "persist:eliza-browser",
      visible: true,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      lastFocusedAt: "2026-04-20T00:00:00.000Z",
    };
    const updatedTab = {
      ...initialTab,
      title: "example.com",
      url: "https://example.com/",
      updatedAt: "2026-04-20T00:01:00.000Z",
    };

    mockClient.getBrowserWorkspace
      .mockResolvedValueOnce({
        mode: "web",
        tabs: [initialTab],
      })
      .mockResolvedValue({
        mode: "web",
        tabs: [updatedTab],
      });
    mockClient.navigateBrowserWorkspaceTab.mockResolvedValue({
      tab: updatedTab,
    });

    render(<BrowserWorkspaceView />);

    const addressInput = await screen.findByDisplayValue("https://milady.ai/");
    fireEvent.change(addressInput, { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    await waitFor(() => {
      expect(mockClient.navigateBrowserWorkspaceTab).toHaveBeenCalledWith(
        "user-tab",
        "https://example.com/",
      );
    });
  });
});
