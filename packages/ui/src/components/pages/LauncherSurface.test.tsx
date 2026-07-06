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
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { useRoutableViews } from "../../hooks/useAvailableViews";
import { saveLauncherRecents } from "../../state/persistence";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { LauncherSurface } from "./LauncherSurface";

let aospEnabled = false;

vi.mock("../../hooks/useAvailableViews", () => ({
  useRoutableViews: vi.fn(),
}));

vi.mock("../../state/useViewKinds", () => ({
  useEnabledViewKinds: vi.fn(),
}));

vi.mock("../../platform/platform-guards", () => ({
  getActiveViewModality: () => "gui",
  getFrontendPlatform: () => "web",
}));

vi.mock("../../navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../navigation")>();
  return { ...actual, isAospShellEnabled: () => aospEnabled };
});

const useRoutableViewsMock = vi.mocked(useRoutableViews);
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
  useRoutableViewsMock.mockReturnValue({
    views,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
}

beforeEach(() => {
  aospEnabled = false;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  useEnabledViewKindsMock.mockReturnValue({ developer: true, preview: true });
  setViews([
    view("chat", "Chat", "/chat"),
    view("views", "Views", "/views"),
    view("wallet", "Wallet", "/wallet", { viewKind: "system" }),
    view("inventory", "Wallet", "/wallet", { visibleInManager: false }),
    view("browser", "Browser", "/browser"),
    view("settings", "Settings", "/settings", { visibleInManager: false }),
    view("shopify", "Shopify", "/shopify"),
    // Mirrors the real plugin-hyperliquid registration (`group: "wallet"`,
    // plugins/plugin-hyperliquid/src/register.ts) — the launcher collapses
    // wallet-group sub-pages, so no standalone Hyperliquid tile.
    view("hyperliquid", "Hyperliquid", "/hyperliquid", { group: "wallet" }),
    view("phone", "Phone", "/phone", { visibleInManager: false }),
    view("trajectories", "Trajectories", "/apps/trajectories", {
      viewKind: "developer",
    }),
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LauncherSurface", () => {
  it("shows curated apps and hides removed/shell/sub-view surfaces", () => {
    render(<LauncherSurface />);

    // No dock: chat/settings tile on the single page alongside everything else.
    expect(screen.queryByTestId("launcher-dock")).toBeNull();

    const page = within(screen.getByTestId("launcher-page-window"));
    // chat is the home surface, not a tile (#14479) — stale assertion fixed:
    // the tile was removed there but this expectation was left behind.
    expect(screen.queryByTestId("launcher-tile-chat")).toBeNull();
    expect(page.getByTestId("launcher-tile-settings")).toBeTruthy();
    expect(page.getByTestId("launcher-tile-wallet")).toBeTruthy();
    expect(page.getByTestId("launcher-tile-browser")).toBeTruthy();

    expect(screen.queryByTestId("launcher-tile-views")).toBeNull();
    expect(screen.queryByTestId("launcher-tile-shopify")).toBeNull();
    expect(screen.queryByTestId("launcher-tile-hyperliquid")).toBeNull();
  });

  it("collapses duplicate wallet registrations to a single tile", () => {
    render(<LauncherSurface />);
    expect(screen.getAllByTestId("launcher-tile-wallet")).toHaveLength(1);
  });

  it("does not render a Recents zone even with persisted recents (removed as duplicate noise)", () => {
    // Recency is still recorded on launch (other surfaces read it) but the
    // launcher no longer surfaces a Recents row, it only mirrored the top of
    // All Apps two rows down (#13453 deslop).
    saveLauncherRecents(["browser", "wallet"]);

    render(<LauncherSurface />);

    expect(screen.queryByRole("heading", { name: "Recents" })).toBeNull();
    expect(screen.queryByTestId("launcher-zone-recents")).toBeNull();
    // The apps themselves still exist once, in All Apps.
    expect(screen.getByTestId("launcher-tile-browser")).toBeTruthy();
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
});
