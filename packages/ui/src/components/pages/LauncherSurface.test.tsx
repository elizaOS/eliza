/** Verifies LauncherSurface through the package's configured test harness. */
// @vitest-environment jsdom
//
// Renders the real LauncherSurface with mocked view/platform hooks to cover
// curation: which surfaces show (curated apps yes; shell/sub-view/removed no),
// collapsing duplicate wallet registrations to one tile, gating native-OS tiles
// on the AOSP fork and developer tools on Developer Mode, and route navigation.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppLaunchResult } from "../../api";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { type ViewEntry, viewToEntry } from "../../hooks/view-catalog";
import { __setAppValueForTests } from "../../state/app-store";
import type { AppContextValue } from "../../state/types";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { LauncherSurface } from "./LauncherSurface";

let aospEnabled = false;
const { useViewCatalogMock } = vi.hoisted(() => ({
  useViewCatalogMock: vi.fn(),
}));
const getMock = vi.fn();
const setActionNoticeMock = vi.fn();
const setStateMock = vi.fn();
const setTabMock = vi.fn();

vi.mock("../../hooks/useViewCatalog", () => ({
  useViewCatalog: useViewCatalogMock,
}));
vi.mock("../../api", () => ({
  client: { getBaseUrl: () => "http://localhost:31337" },
}));
vi.mock("../../api/app-shell-capabilities", () => ({
  isLimitedCloudAgentApiResourceUrl: () => false,
  supportsFullAppShellRoutes: () => true,
}));
vi.mock("../../utils/openExternalUrl", () => ({
  openExternalUrl: vi.fn(),
}));

vi.mock("../../state/useViewKinds", () => ({
  useEnabledViewKinds: vi.fn(),
}));

vi.mock("../../platform/platform-guards", () => ({
  getActiveViewModality: () => "gui",
  getFrontendPlatform: () => "web",
}));

vi.mock("../../navigation", () => {
  return {
    isAospShellEnabled: () => aospEnabled,
    LAUNCHER_AOSP_ONLY_VIEW_IDS: ["phone"],
    pathForTab: (id: string) => `/${id}`,
  };
});

const useEnabledViewKindsMock = vi.mocked(useEnabledViewKinds);

function view(
  id: string,
  label: string,
  path: string,
  options: Partial<ViewRegistryEntry> = {},
): ViewRegistryEntry {
  return {
    id,
    label,
    viewType: "gui",
    path,
    available: true,
    pluginName: "@elizaos/builtin",
    visibleInManager: true,
    builtin: true,
    viewKind: "release",
    ...options,
  };
}

function setViews(views: ViewRegistryEntry[]) {
  setEntries(views.map(viewToEntry));
}

function setEntries(entries: ViewEntry[]) {
  useViewCatalogMock.mockReturnValue({
    entries,
    loading: false,
    error: null,
    refresh: vi.fn(),
    get: getMock,
  });
}

beforeEach(() => {
  aospEnabled = false;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  getMock.mockResolvedValue(null);
  __setAppValueForTests({
    appRuns: [],
    elizaCloudConnected: false,
    startupCoordinator: {
      state: { phase: "ready" },
      dispatch: vi.fn(),
      retry: vi.fn(),
      reset: vi.fn(),
      pairingSuccess: vi.fn(),
      firstRunComplete: vi.fn(),
      policy: {
        supportsLocalRuntime: true,
        backendTimeoutMs: 30_000,
        agentReadyTimeoutMs: 30_000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      loading: false,
      terminal: true,
      isShellPaintable: true,
      isInteractive: true,
      statusMessageKey: "startupshell.Loading",
      error: null,
      target: "embedded-local",
      phase: "ready",
    },
    setActionNotice: setActionNoticeMock,
    setState: setStateMock,
    setTab: setTabMock,
    t: (key: string) => key,
  } as unknown as AppContextValue);
  useEnabledViewKindsMock.mockReturnValue({ developer: true, preview: true });
  setViews([
    view("chat", "Chat", "/chat"),
    view("views", "Views", "/views"),
    view("wallet", "Wallet", "/wallet", { viewKind: "system" }),
    view("inventory", "Wallet", "/wallet", { visibleInManager: false }),
    view("browser", "Browser", "/browser"),
    view("settings", "Settings", "/settings", { visibleInManager: false }),
    // Wallet-group sub-pages collapse under the parent, so they do not create
    // duplicate launcher tiles.
    view("wallet-trading", "Trading", "/wallet/trading", { group: "wallet" }),
    view("phone", "Phone", "/phone", { visibleInManager: false }),
    view("trajectories", "Trajectories", "/apps/trajectories", {
      viewKind: "developer",
    }),
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __setAppValueForTests(null);
});

describe("LauncherSurface", () => {
  it("supports full-page and embedded layouts without duplicating chat clearance", () => {
    const { rerender } = render(<LauncherSurface />);
    const surface = screen.getByTestId("launcher-surface");
    expect(surface.getAttribute("data-layout")).toBe("page");
    expect(surface.className).toContain("absolute");
    expect(surface.className).not.toContain("--eliza-chat-clearance");
    expect(screen.getByTestId("launcher-page-window").className).toContain(
      "--eliza-chat-clearance",
    );
    expect(screen.getByTestId("launcher-page-window").className).toContain(
      "--eliza-chat-side-clearance",
    );

    rerender(<LauncherSurface layout="embedded" />);
    expect(surface.getAttribute("data-layout")).toBe("embedded");
    expect(surface.className).toContain("relative");
    expect(surface.className).not.toContain("--eliza-chat-clearance");
    expect(screen.getByTestId("launcher-page-window").className).toContain(
      "overflow-visible",
    );
  });

  it("shows curated apps and hides removed/shell/sub-view surfaces", () => {
    render(<LauncherSurface />);

    // No dock: settings/wallet tile on the single page alongside everything else.
    expect(screen.queryByTestId("launcher-dock")).toBeNull();

    const page = within(screen.getByTestId("launcher-page-window"));
    // chat is the home surface, not a tile (#14479) — stale assertion fixed:
    // the tile was removed there but this expectation was left behind.
    expect(screen.queryByTestId("launcher-tile-chat")).toBeNull();
    expect(page.getByTestId("launcher-tile-settings")).toBeTruthy();
    expect(page.getByTestId("launcher-tile-wallet")).toBeTruthy();
    expect(page.getByTestId("launcher-tile-browser")).toBeTruthy();

    // chat is the home surface, never a launcher tile (#14479).
    expect(screen.queryByTestId("launcher-tile-chat")).toBeNull();
    expect(screen.queryByTestId("launcher-tile-views")).toBeNull();
    expect(screen.queryByTestId("launcher-tile-wallet-trading")).toBeNull();
  });

  it("keeps catalog-only and uncurated registered apps off the demo rail", () => {
    const catalogOnly: ViewEntry = {
      key: "app:@elizaos/plugin-birdclaw",
      id: "@elizaos/plugin-birdclaw",
      label: "Birdclaw",
      modality: "gui",
      state: "available",
      kind: "app",
      appName: "@elizaos/plugin-birdclaw",
      hasHero: false,
    };
    setEntries([
      viewToEntry(view("settings", "Settings", "/settings")),
      viewToEntry(view("inbox", "Inbox", "/apps/inbox")),
      catalogOnly,
    ]);

    render(<LauncherSurface catalogMode="demo" />);

    expect(
      screen.queryByTestId("launcher-tile-@elizaos/plugin-birdclaw"),
    ).toBeNull();
    expect(screen.queryByTestId("launcher-tile-inbox")).toBeNull();
    expect(screen.getByTestId("launcher-tile-settings")).toBeTruthy();
  });

  it("collapses duplicate wallet registrations to a single tile", () => {
    render(<LauncherSurface />);
    expect(screen.getAllByTestId("launcher-tile-wallet")).toHaveLength(1);
  });

  it("hides native-OS tiles off the AOSP fork and shows them on it", () => {
    render(<LauncherSurface />);
    expect(screen.queryByTestId("launcher-tile-phone")).toBeNull();
    cleanup();

    aospEnabled = true;
    render(<LauncherSurface />);
    expect(screen.getByTestId("launcher-tile-phone")).toBeTruthy();
  });

  it("shows developer tools on the single page when Developer Mode is on", () => {
    // beforeEach enables developer mode. One page — no second launcher page.
    render(<LauncherSurface />);
    expect(screen.queryByTestId("launcher-page-1")).toBeNull();
    const page = within(screen.getByTestId("launcher-page-window"));
    expect(page.getByTestId("launcher-tile-trajectories")).toBeTruthy();
  });

  it("hides developer tools when Developer Mode is off (default)", () => {
    useEnabledViewKindsMock.mockReturnValue({
      developer: false,
      preview: false,
    });
    render(<LauncherSurface />);
    expect(screen.queryByTestId("launcher-tile-trajectories")).toBeNull();
    // Everyday apps still tile on the single page.
    expect(screen.getByTestId("launcher-tile-wallet")).toBeTruthy();
  });

  it("navigates loaded views through the browser route", () => {
    render(<LauncherSurface />);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(window.location.pathname).toBe("/browser");
  });

  it("opens an installable app's returned viewer on the first launch", async () => {
    const rubyHigh: ViewEntry = {
      key: "app:@rati-osf/plugin-ruby-high",
      id: "@rati-osf/plugin-ruby-high",
      label: "Ruby High",
      modality: "gui",
      state: "available",
      kind: "app",
      appName: "@rati-osf/plugin-ruby-high",
      launchType: "connect",
      launchUrl: null,
      hasHero: false,
    };
    const run = {
      runId: "ruby-run-1",
      appName: "@rati-osf/plugin-ruby-high",
      displayName: "Ruby High",
      viewer: {
        url: "/ruby-high/viewer",
        postMessageAuth: false,
        sandbox: "allow-scripts allow-same-origin allow-popups",
      },
    };
    setEntries([rubyHigh]);
    getMock.mockResolvedValue({
      pluginInstalled: true,
      needsRestart: false,
      displayName: "Ruby High",
      launchType: "connect",
      launchUrl: null,
      viewer: run.viewer,
      session: null,
      run,
    } as AppLaunchResult);

    render(<LauncherSurface />);
    fireEvent.click(screen.getByRole("button", { name: "Ruby High" }));

    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith(rubyHigh);
      expect(setStateMock).toHaveBeenCalledWith("appRuns", [run]);
      expect(setStateMock).toHaveBeenCalledWith(
        "activeGameRunId",
        "ruby-run-1",
      );
      expect(setStateMock).toHaveBeenCalledWith("appsSubTab", "games");
      expect(window.location.pathname).toBe("/apps/ruby-high");
    });
  });
});
