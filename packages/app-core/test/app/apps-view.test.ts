// @vitest-environment jsdom

import type {
  AppLaunchResult,
  AppViewerAuthMessage,
  RegistryAppInfo,
} from "@elizaos/app-core/api";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface AppsContextStub {
  setState: (
    key: string,
    value: string | boolean | AppViewerAuthMessage | null,
  ) => void;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
}

const { mockClientFns, mockUseApp } = vi.hoisted(() => ({
  mockClientFns: {
    getCodingAgentStatus: vi.fn(async () => null),
    listApps: vi.fn(),
    listInstalledApps: vi.fn(),
    launchApp: vi.fn(),
  },
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClientFns,
}));
vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

import {
  AppsView,
  shouldShowAppInAppsView,
} from "@elizaos/app-core/components/AppsView";

function createApp(
  name: string,
  displayName: string,
  description: string,
  overrides: Partial<RegistryAppInfo> = {},
): RegistryAppInfo {
  return {
    name,
    displayName,
    description,
    category: "app",
    launchType: "connect",
    launchUrl: `https://example.com/${displayName.toLowerCase()}`,
    icon: null,
    capabilities: ["observe"],
    stars: 1,
    repository: "https://github.com/example/repo",
    latestVersion: "1.0.0",
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: name,
      v0Version: null,
      v1Version: null,
      v2Version: "1.0.0",
    },
    ...overrides,
  };
}

function createLaunchResult(
  overrides?: Partial<AppLaunchResult>,
): AppLaunchResult {
  return {
    pluginInstalled: true,
    needsRestart: false,
    displayName: "Test App",
    launchType: "connect",
    launchUrl: "https://example.com/launch",
    viewer: {
      url: "https://example.com/viewer",
      postMessageAuth: false,
      sandbox: "allow-scripts",
    },
    ...overrides,
  };
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : ""))
    .join("")
    .trim();
}

function findButtonByText(
  root: TestRenderer.ReactTestInstance,
  label: string,
): TestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) => node.type === "button" && text(node) === label,
  );
  if (!matches[0]) {
    throw new Error(`Button "${label}" not found`);
  }
  return matches[0];
}

function findButtonByTitle(
  root: TestRenderer.ReactTestInstance,
  title: string,
): TestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) => node.type === "button" && node.props.title === title,
  );
  if (!matches[0]) {
    throw new Error(`Button titled "${title}" not found`);
  }
  return matches[0];
}

function findTextareaByPlaceholder(
  root: TestRenderer.ReactTestInstance,
  placeholder: string,
): TestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.type === "textarea" && node.props.placeholder === placeholder,
  );
  if (!matches[0]) {
    throw new Error(`Textarea "${placeholder}" not found`);
  }
  return matches[0];
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  attempts = 20,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

describe("AppsView", () => {
  beforeEach(() => {
    mockClientFns.listApps.mockReset();
    mockClientFns.listInstalledApps.mockReset();
    mockClientFns.launchApp.mockReset();
    mockUseApp.mockReset();

    mockClientFns.listInstalledApps.mockResolvedValue([]);
  });

  const tStub = (k: string) => k;

  afterEach(() => {
    delete (window as typeof window & { electron?: unknown }).electron;
    vi.restoreAllMocks();
  });

  it("uses an exact clawbal allowlist in production", () => {
    expect(
      shouldShowAppInAppsView(
        createApp("@iqlabs-official/plugin-clawbal", "Clawbal", "Game"),
        true,
      ),
    ).toBe(true);
    expect(
      shouldShowAppInAppsView(
        createApp("evil-clawbal", "Spoof", "Spoofed package"),
        true,
      ),
    ).toBe(false);
    expect(
      shouldShowAppInAppsView(
        createApp("@elizaos/app-babylon", "Babylon", "Wallet"),
        true,
      ),
    ).toBe(false);
  });

  it("does not restrict the apps list by clawbal in development", () => {
    expect(
      shouldShowAppInAppsView(
        createApp("@elizaos/app-babylon", "Babylon", "Wallet"),
        false,
      ),
    ).toBe(true);
  });

  it("loads apps and launches iframe viewer flow", async () => {
    const setState = vi.fn<AppsContextStub["setState"]>();
    const setActionNotice = vi.fn<AppsContextStub["setActionNotice"]>();
    const t = (k: string) => {
      if (k === "appsview.Active") return "Active";
      if (k === "appsview.Back") return "Back";
      if (k === "appsview.Refresh") return "Refresh";
      if (k === "appsview.ActiveOnly") return "Active Only";
      if (k === "appsview.SaySomethingToSel")
        return "Say something to selected agent...";
      return k;
    };
    mockUseApp.mockReturnValue({
      uiLanguage: "en",
      t,
      setState,
      setActionNotice,
    });
    const app = createApp("@elizaos/app-2004scape", "2004scape", "RuneScape");
    mockClientFns.listApps.mockResolvedValue([app]);
    mockClientFns.launchApp.mockResolvedValue(
      createLaunchResult({
        displayName: app.displayName,
        viewer: {
          url: "http://localhost:5175",
          sandbox: "allow-scripts allow-same-origin",
          postMessageAuth: true,
          authMessage: {
            type: "RS_2004SCAPE_AUTH",
            authToken: "testbot",
            sessionToken: "password",
          },
        },
      }),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(AppsView));
    });
    await flush();

    const launchButton = findButtonByText(tree?.root, "Launch");
    await act(async () => {
      await launchButton.props.onClick();
    });

    expect(mockClientFns.launchApp).toHaveBeenCalledWith(app.name);
    expect(setState).toHaveBeenCalledWith("activeGameApp", app.name);
    expect(setState).toHaveBeenCalledWith(
      "activeGameDisplayName",
      app.displayName,
    );
    expect(setState).toHaveBeenCalledWith(
      "activeGameViewerUrl",
      "http://localhost:5175",
    );
    expect(setState).toHaveBeenCalledWith("activeGamePostMessageAuth", true);
    expect(setState).toHaveBeenCalledWith("tab", "apps");
    expect(setState).toHaveBeenCalledWith("appsSubTab", "games");
    expect(
      setActionNotice.mock.calls.some((call) =>
        String(call[0]).includes("requires iframe auth"),
      ),
    ).toBe(false);
  });

  it("shows auth warning when postMessage auth payload is missing", async () => {
    const setState = vi.fn<AppsContextStub["setState"]>();
    const setActionNotice = vi.fn<AppsContextStub["setActionNotice"]>();
    mockUseApp.mockReturnValue({
      uiLanguage: "en",
      t: tStub,
      setState,
      setActionNotice,
    });
    const app = createApp("@elizaos/app-2004scape", "2004scape", "RuneScape");
    mockClientFns.listApps.mockResolvedValue([app]);
    mockClientFns.launchApp.mockResolvedValue(
      createLaunchResult({
        displayName: app.displayName,
        viewer: {
          url: "http://localhost:5175",
          sandbox: "allow-scripts allow-same-origin",
          postMessageAuth: true,
        },
      }),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(AppsView));
    });
    await flush();

    await act(async () => {
      await findButtonByText(tree?.root, "Launch").props.onClick();
    });

    expect(setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("requires iframe auth"),
      "error",
      4800,
    );
    expect(setState).toHaveBeenCalledWith("tab", "apps");
    expect(setState).toHaveBeenCalledWith("appsSubTab", "games");
  });

  it("opens non-viewer launches in a new tab and resets active game state", async () => {
    const setState = vi.fn<AppsContextStub["setState"]>();
    const setActionNotice = vi.fn<AppsContextStub["setActionNotice"]>();
    mockUseApp.mockReturnValue({
      uiLanguage: "en",
      t: tStub,
      setState,
      setActionNotice,
    });
    const app = createApp("@elizaos/app-babylon", "Babylon", "Wallet app");
    mockClientFns.listApps.mockResolvedValue([app]);
    mockClientFns.launchApp.mockResolvedValue(
      createLaunchResult({
        displayName: app.displayName,
        launchUrl: "https://example.com/babylon",
        viewer: null,
      }),
    );

    const popupSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(AppsView));
    });
    await flush();

    await act(async () => {
      await findButtonByText(tree?.root, "Launch").props.onClick();
    });

    expect(popupSpy).toHaveBeenCalledWith(
      "https://example.com/babylon",
      "_blank",
      "noopener,noreferrer",
    );
    expect(setState).toHaveBeenCalledWith("activeGameApp", "");
    expect(setState).toHaveBeenCalledWith("activeGameViewerUrl", "");
    expect(setActionNotice).toHaveBeenCalledWith(
      "Babylon opened in a new tab.",
      "success",
      2600,
    );
  });

  it("reports popup-blocked errors and launch failures", async () => {
    const setState = vi.fn<AppsContextStub["setState"]>();
    const setActionNotice = vi.fn<AppsContextStub["setActionNotice"]>();
    mockUseApp.mockReturnValue({
      uiLanguage: "en",
      t: tStub,
      setState,
      setActionNotice,
    });
    const app = createApp("@elizaos/app-babylon", "Babylon", "Wallet app");
    mockClientFns.listApps.mockResolvedValue([app]);
    mockClientFns.launchApp
      .mockResolvedValueOnce(
        createLaunchResult({
          displayName: app.displayName,
          launchUrl: "https://example.com/babylon",
          viewer: null,
        }),
      )
      .mockRejectedValueOnce(new Error("network down"));

    vi.spyOn(window, "open").mockReturnValue(null);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(AppsView));
    });
    await flush();

    await act(async () => {
      await findButtonByText(tree?.root, "Launch").props.onClick();
    });
    expect(setActionNotice).toHaveBeenCalledWith(
      "Popup blocked while opening Babylon. Allow popups and try again.",
      "error",
      4200,
    );

    await act(async () => {
      await findButtonByText(tree?.root, "Launch").props.onClick();
    });
    expect(setActionNotice).toHaveBeenCalledWith(
      "Failed to launch Babylon: network down",
      "error",
      4000,
    );
  });

  it("uses the Electrobun shell bridge for external app launches", async () => {
    const setState = vi.fn<AppsContextStub["setState"]>();
    const setActionNotice = vi.fn<AppsContextStub["setActionNotice"]>();
    const request = vi.fn(async () => undefined);
    mockUseApp.mockReturnValue({
      uiLanguage: "en",
      t: tStub,
      setState,
      setActionNotice,
    });
    const app = createApp("@elizaos/app-babylon", "Babylon", "Wallet app");
    mockClientFns.listApps.mockResolvedValue([app]);
    mockClientFns.launchApp.mockResolvedValue(
      createLaunchResult({
        displayName: app.displayName,
        launchUrl: "https://example.com/babylon",
        viewer: null,
      }),
    );
    Object.defineProperty(window, "__ELIZA_ELECTROBUN_RPC__", {
      configurable: true,
      writable: true,
      value: {
        request: { desktopOpenExternal: request },
        onMessage: vi.fn(),
        offMessage: vi.fn(),
      },
    });
    const popupSpy = vi.spyOn(window, "open");

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(AppsView));
    });
    await flush();

    await act(async () => {
      await findButtonByText(tree?.root, "Launch").props.onClick();
    });

    expect(request).toHaveBeenCalledWith({
      url: "https://example.com/babylon",
    });
    expect(popupSpy).not.toHaveBeenCalled();
    expect(setActionNotice).toHaveBeenCalledWith(
      "Babylon opened in a new tab.",
      "success",
      2600,
    );
  });

  it("refreshes list and applies search filtering", async () => {
    const setState = vi.fn<AppsContextStub["setState"]>();
    const setActionNotice = vi.fn<AppsContextStub["setActionNotice"]>();
    mockUseApp.mockReturnValue({
      uiLanguage: "en",
      t: tStub,
      setState,
      setActionNotice,
    });
    const appOne = createApp("@elizaos/app-2004scape", "2004scape", "RuneScape");
    const appTwo = createApp("@elizaos/app-babylon", "Babylon", "Wallet");
    mockClientFns.listApps.mockResolvedValue([appOne, appTwo]);
    mockClientFns.listInstalledApps.mockResolvedValue([
      {
        name: appOne.name,
        displayName: appOne.displayName,
        version: "1.0.0",
        installPath: "/tmp/app-one",
        installedAt: "2026-01-01T00:00:00.000Z",
        isRunning: true,
      },
    ]);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(AppsView));
    });
    await flush();

    const root = tree?.root;
    expect(
      root.findAll(
        (node) =>
          node.type === "button" && node.props.title === "Open 2004scape",
      ).length,
    ).toBe(1);
    expect(
      root.findAll(
        (node) => node.type === "button" && node.props.title === "Open Babylon",
      ).length,
    ).toBe(1);
    expect(
      root.findAll((node) => text(node) === "appsview.Active").length,
    ).toBeGreaterThanOrEqual(1);

    const searchInput = root.findByType("input");
    await act(async () => {
      searchInput.props.onChange({ target: { value: "2004" } });
    });
    expect(
      root.findAll(
        (node) =>
          node.type === "button" && node.props.title === "Open 2004scape",
      ).length,
    ).toBe(1);
    expect(
      root.findAll(
        (node) => node.type === "button" && node.props.title === "Open Babylon",
      ).length,
    ).toBe(0);

    await act(async () => {
      await findButtonByText(root, "appsview.Refresh").props.onClick();
    });
    expect(mockClientFns.listApps).toHaveBeenCalledTimes(2);

    await act(async () => {
      searchInput.props.onChange({ target: { value: "" } });
    });
    await act(async () => {
      await findButtonByText(root, "appsview.ActiveOnly").props.onClick();
    });
    expect(
      root.findAll(
        (node) =>
          node.type === "button" && node.props.title === "Open 2004scape",
      ).length,
    ).toBe(1);
    expect(
      root.findAll(
        (node) => node.type === "button" && node.props.title === "Open Babylon",
      ).length,
    ).toBe(0);
  });

  it("opens app details and can return to the app list", async () => {
    const setState = vi.fn<AppsContextStub["setState"]>();
    const setActionNotice = vi.fn<AppsContextStub["setActionNotice"]>();
    mockUseApp.mockReturnValue({
      uiLanguage: "en",
      t: tStub,
      setState,
      setActionNotice,
    });
    const appOne = createApp("@elizaos/app-2004scape", "2004scape", "RuneScape");
    const appTwo = createApp("@elizaos/app-babylon", "Babylon", "Wallet");
    mockClientFns.listApps.mockResolvedValue([appOne, appTwo]);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(AppsView));
    });
    await flush();

    await act(async () => {
      findButtonByTitle(tree?.root, "Open Babylon").props.onClick();
    });
    expect(
      tree?.root.findAll((node) => text(node) === "appsview.Back").length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      tree?.root.findAll((node) => text(node) === "Babylon").length,
    ).toBeGreaterThan(0);

    await act(async () => {
      findButtonByText(tree?.root, "appsview.Back").props.onClick();
    });
    expect(
      tree?.root.findAll(
        (node) => text(node) === "Select an app to view details",
      ).length,
    ).toBe(1);
    expect(
      tree?.root.findAll(
        (node) =>
          node.type === "button" && node.props.title === "Open 2004scape",
      ).length,
    ).toBe(1);
    expect(
      tree?.root.findAll(
        (node) => node.type === "button" && node.props.title === "Open Babylon",
      ).length,
    ).toBe(1);
  });
});
