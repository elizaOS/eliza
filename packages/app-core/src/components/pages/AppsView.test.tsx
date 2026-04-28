// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsView } from "./AppsView";

const { clientMock, invokeDesktopBridgeRequestMock } = vi.hoisted(() => ({
  clientMock: {
    attachAppRun: vi.fn(),
    heartbeatAppRun: vi.fn(),
    launchApp: vi.fn(),
    listAppRuns: vi.fn(),
    listApps: vi.fn(),
    listCatalogApps: vi.fn(),
  },
  invokeDesktopBridgeRequestMock: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  PageLayout: ({
    children,
    sidebar,
  }: {
    children: ReactNode;
    sidebar?: ReactNode;
  }) => (
    <div>
      {sidebar}
      <main>{children}</main>
    </div>
  ),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../bridge", () => ({
  invokeDesktopBridgeRequest: invokeDesktopBridgeRequestMock,
  isElectrobunRuntime: () => true,
  subscribeDesktopBridgeEvent: () => () => {},
}));

vi.mock("../../state", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    useApp: () => {
      const [appRuns, setAppRuns] = React.useState<unknown[]>([]);
      const [appsSubTab, setAppsSubTab] = React.useState("browse");
      const [recentApps, setRecentApps] = React.useState<string[]>([]);
      const setState = React.useCallback((key: string, value: unknown) => {
        if (key === "appRuns" && Array.isArray(value)) setAppRuns(value);
        if (key === "appsSubTab" && typeof value === "string") {
          setAppsSubTab(value);
        }
        if (key === "recentApps" && Array.isArray(value)) {
          setRecentApps(value as string[]);
        }
      }, []);
      const noop = React.useCallback(() => {}, []);
      const translate = React.useCallback(
        (_key: string, values?: { defaultValue?: string }) =>
          values?.defaultValue ?? _key,
        [],
      );

      return {
        activeGameRunId: null,
        activeGameViewerUrl: null,
        appRuns,
        appsSubTab,
        favoriteApps: [],
        recentApps,
        setActionNotice: noop,
        setState,
        setTab: noop,
        t: translate,
      };
    },
  };
});

vi.mock("../../state/useApp", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    useApp: () => {
      const noop = React.useCallback(() => {}, []);
      const translate = React.useCallback(
        (_key: string, values?: { defaultValue?: string }) =>
          values?.defaultValue ?? _key,
        [],
      );

      return {
        appRuns: [],
        plugins: [],
        setActionNotice: noop,
        setState: noop,
        setTab: noop,
        t: translate,
      };
    },
  };
});

vi.mock("../apps/AppsSidebar", () => ({
  AppsSidebar: () => <aside data-testid="apps-sidebar" />,
}));

vi.mock("../apps/RunningAppsRow", () => ({
  RunningAppsRow: () => <section data-testid="running-apps-row" />,
}));

vi.mock("../apps/AppsCatalogGrid", () => ({
  AppsCatalogGrid: ({
    loading,
    onLaunch,
    visibleApps,
  }: {
    loading: boolean;
    onLaunch: (app: { name: string }) => void;
    visibleApps: Array<{ name: string; displayName?: string | null }>;
  }) => {
    const launchableApp =
      visibleApps.find(
        (app) => app.name === "@elizaos/app-defense-of-the-agents",
      ) ?? visibleApps.find((app) => app.name === "@elizaos/app-plugin-viewer");
    return (
      <button
        type="button"
        disabled={loading || !launchableApp}
        onClick={() => {
          if (launchableApp) onLaunch(launchableApp);
        }}
      >
        Open {launchableApp?.displayName ?? "App"}
      </button>
    );
  },
}));

function createCatalogApp(name: string, displayName: string) {
  return {
    name,
    displayName,
    description: `${displayName} test app`,
    category: "game",
    launchType: "local",
    launchUrl: null,
    icon: null,
    heroImage: null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: name,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
  };
}

function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

describe("AppsView", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    window.history.replaceState(null, "", "/apps");
    window.localStorage.clear();
    clientMock.attachAppRun.mockResolvedValue({ run: null });
    clientMock.heartbeatAppRun.mockResolvedValue(undefined);
    clientMock.launchApp.mockResolvedValue({});
    clientMock.listAppRuns.mockResolvedValue([]);
    clientMock.listApps.mockResolvedValue([]);
    clientMock.listCatalogApps.mockResolvedValue([
      createCatalogApp(
        "@elizaos/app-defense-of-the-agents",
        "Defense of the Agents",
      ),
    ]);
    invokeDesktopBridgeRequestMock.mockResolvedValue({
      id: "app-window",
      alwaysOnTop: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("routes game apps to the details page before launching", async () => {
    render(<AppsView />);

    expect(
      screen.queryByRole("checkbox", { name: "Open apps in windows" }),
    ).toBeNull();

    const launchButton = await screen.findByRole("button", {
      name: "Open Defense of the Agents",
    });

    fireEvent.click(launchButton);

    await waitFor(() => {
      expect(window.location.pathname).toBe(
        "/apps/defense-of-the-agents/details",
      );
    });

    expect(clientMock.launchApp).not.toHaveBeenCalled();
    expect(invokeDesktopBridgeRequestMock).not.toHaveBeenCalled();
    expect(await screen.findByTestId("app-launch-panel")).toBeTruthy();
  });

  it("opens lightweight route apps in desktop windows by default", async () => {
    clientMock.listCatalogApps.mockResolvedValue([]);

    render(<AppsView />);

    const launchButton = await screen.findByRole("button", {
      name: "Open Plugin Viewer",
    });

    fireEvent.click(launchButton);

    await waitFor(() => {
      expect(invokeDesktopBridgeRequestMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeDesktopBridgeRequestMock).toHaveBeenCalledTimes(1);
    expect(invokeDesktopBridgeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopOpenAppWindow",
        params: expect.objectContaining({
          path: "/apps/plugins",
        }),
      }),
    );
    expect(clientMock.launchApp).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/apps/plugin-viewer");
  });
});
