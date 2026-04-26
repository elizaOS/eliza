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

describe("AppsView", () => {
  beforeEach(() => {
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

  it("does not open a desktop app window by default", async () => {
    render(<AppsView />);

    const launchButton = await screen.findByRole("button", {
      name: "Open Defense of the Agents",
    });

    fireEvent.click(launchButton);

    await waitFor(() => {
      expect(clientMock.launchApp).toHaveBeenCalledWith(
        "@elizaos/app-defense-of-the-agents",
      );
    });

    expect(invokeDesktopBridgeRequestMock).not.toHaveBeenCalled();
  });

  it("opens route apps in desktop windows only when the window preference is enabled", async () => {
    render(<AppsView />);

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Open apps in windows" }),
    );

    const launchButton = await screen.findByRole("button", {
      name: "Open Defense of the Agents",
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
          path: "/apps/defense-of-the-agents",
        }),
      }),
    );
    expect(clientMock.launchApp).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/apps/defense-of-the-agents");
  });
});
