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
    const pluginViewer = visibleApps.find(
      (app) => app.name === "@elizaos/app-plugin-viewer",
    );
    return (
      <button
        type="button"
        disabled={loading || !pluginViewer}
        onClick={() => {
          if (pluginViewer) onLaunch(pluginViewer);
        }}
      >
        Open Plugin Viewer
      </button>
    );
  },
}));

describe("AppsView", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/apps");
    clientMock.attachAppRun.mockResolvedValue({ run: null });
    clientMock.heartbeatAppRun.mockResolvedValue(undefined);
    clientMock.launchApp.mockResolvedValue({});
    clientMock.listAppRuns.mockResolvedValue([]);
    clientMock.listApps.mockResolvedValue([]);
    clientMock.listCatalogApps.mockResolvedValue([]);
    invokeDesktopBridgeRequestMock.mockResolvedValue({
      id: "plugins-window",
      alwaysOnTop: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not auto-launch a second native app window after a manual catalog launch updates the route", async () => {
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
    expect(window.location.pathname).toBe("/apps/plugin-viewer");
  });
});
