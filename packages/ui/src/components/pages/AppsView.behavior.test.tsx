// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryAppInfo } from "../../api";
import {
  getBootConfig,
  setBootConfig,
} from "../../config/boot-config-store";
import type { MockAppOptions } from "../../storybook/mock-providers";
import { MockAppProvider } from "../../storybook/mock-providers";
import { AppsCatalogGrid } from "../apps/AppsCatalogGrid";

/**
 * Behavioral coverage for the apps page. Two layers:
 *
 *  1. `AppsCatalogGrid` — the presentational catalog. Its collaborators are the
 *     injected `onLaunch` / `onToggleFavorite` / `onRetry` callbacks, so we can
 *     assert the EXACT handler + payload for every interaction plus the
 *     loading / empty / search-empty / error render branches with zero mocking.
 *
 *  2. `AppsView` — the container that owns the real launch + favorite wiring.
 *     We mock only the collaborators it does NOT own (`client` API + the
 *     registry loader `loadAppsCatalog`) and drive the real DOM to prove that
 *     launching an app calls `client.launchApp(<app id>)` and toggling a
 *     favorite calls `setState("favoriteApps", <next list>)` with the right
 *     payload.
 *
 * Regression guards (each assertion has a concrete way to fail):
 *  - AppCard launch button losing its `onLaunch(app)` wiring → grid tests fail.
 *  - AppCard favorite button dropping `event.stopPropagation()` → the
 *    "favorite does not launch" test fails (launch spy would fire).
 *  - handleLaunch routing a plain catalog app somewhere other than
 *    `client.launchApp` (e.g. re-adding an overlay/details short-circuit) →
 *    container launch test fails.
 *  - handleToggleFavorite computing the wrong next array → container favorite
 *    tests fail.
 */

const {
  launchApp,
  listAppRuns,
  loadAppsCatalog,
  clientMock,
} = vi.hoisted(() => {
  const launchApp = vi.fn();
  const listAppRuns = vi.fn(async () => [] as unknown[]);
  const loadAppsCatalog = vi.fn(async () => [] as unknown[]);
  const clientMock = new Proxy(
    {
      launchApp,
      listAppRuns,
      heartbeatAppRun: vi.fn(async () => {}),
      attachAppRun: vi.fn(async () => ({ run: null })),
      stopAppRun: vi.fn(async () => ({})),
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        return prop in target ? target[prop] : vi.fn();
      },
    },
  );
  return { launchApp, listAppRuns, loadAppsCatalog, clientMock };
});

vi.mock("../apps/load-apps-catalog", () => ({ loadAppsCatalog }));
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, client: clientMock };
});

// Imported after vi.mock so the mocked `../../api` client is used by AppsView.
const { AppsView } = await import("./AppsView");

const APP_NAME = "acme-notes";

function makeApp(overrides: Partial<RegistryAppInfo> = {}): RegistryAppInfo {
  return {
    name: APP_NAME,
    displayName: "Acme Notes",
    description: "A simple note utility",
    category: "utility",
    launchType: "iframe",
    launchUrl: null,
    icon: null,
    heroImage: null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: "@acme/notes",
      v0Version: null,
      v1Version: null,
      v2Version: "1.0.0",
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Layer 1: AppsCatalogGrid (presentational boundary) ─────────────────────

function renderGrid(props: Partial<Parameters<typeof AppsCatalogGrid>[0]> = {}) {
  const onLaunch = vi.fn();
  const onToggleFavorite = vi.fn();
  const onRetry = vi.fn();
  const utils = render(
    <MockAppProvider>
      <AppsCatalogGrid
        activeAppNames={new Set()}
        error={null}
        favoriteAppNames={new Set()}
        loading={false}
        searchQuery=""
        visibleApps={[makeApp()]}
        onLaunch={onLaunch}
        onToggleFavorite={onToggleFavorite}
        onRetry={onRetry}
        {...props}
      />
    </MockAppProvider>,
  );
  return { ...utils, onLaunch, onToggleFavorite, onRetry };
}

describe("AppsCatalogGrid interactions", () => {
  it("clicking an app card fires onLaunch with the exact app object", () => {
    const { getByTestId, onLaunch, onToggleFavorite } = renderGrid();
    fireEvent.click(getByTestId(`app-card-${APP_NAME}`));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ name: APP_NAME }),
    );
    // Launching must not toggle the favorite state.
    expect(onToggleFavorite).not.toHaveBeenCalled();
  });

  it("the favorite button toggles favorite WITHOUT launching (stopPropagation)", () => {
    const { getByLabelText, onLaunch, onToggleFavorite } = renderGrid();
    fireEvent.click(getByLabelText("Add to favorites"));
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onToggleFavorite).toHaveBeenCalledWith(APP_NAME);
    // stopPropagation on the star button must prevent the card launch.
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("renders the favorited affordance when the app is already a favorite", () => {
    const { getByLabelText } = renderGrid({
      favoriteAppNames: new Set([APP_NAME]),
    });
    // A favorited card exposes the inverse action label.
    expect(getByLabelText("Remove from favorites")).not.toBeNull();
  });

  it("rapid double-click on the launch button fires onLaunch for every click", () => {
    const { getByTestId, onLaunch } = renderGrid();
    const card = getByTestId(`app-card-${APP_NAME}`);
    fireEvent.click(card);
    fireEvent.click(card);
    expect(onLaunch).toHaveBeenCalledTimes(2);
  });

  it("shows the empty-catalog copy when there are no visible apps and no search", () => {
    const { getByText, queryByTestId } = renderGrid({ visibleApps: [] });
    expect(getByText("appsview.NoAppsAvailable")).not.toBeNull();
    expect(queryByTestId(`app-card-${APP_NAME}`)).toBeNull();
  });

  it("shows the no-search-match copy when a search yields nothing", () => {
    const { getByText, queryByText } = renderGrid({
      visibleApps: [],
      searchQuery: "zzz-nothing",
    });
    expect(getByText("appsview.NoAppsMatchSearch")).not.toBeNull();
    expect(queryByText("appsview.NoAppsAvailable")).toBeNull();
  });

  it("renders a status region while loading and no cards", () => {
    const { getByRole, queryByTestId } = renderGrid({
      loading: true,
      visibleApps: [],
    });
    expect(getByRole("status")).not.toBeNull();
    expect(queryByTestId(`app-card-${APP_NAME}`)).toBeNull();
  });

  it("surfaces the error message and fires onRetry when the retry button is used", () => {
    const { getByText, onRetry } = renderGrid({
      error: "Registry unavailable",
      visibleApps: [],
    });
    expect(getByText("Registry unavailable")).not.toBeNull();
    fireEvent.click(getByText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

// ── Layer 2: AppsView container (real launch + favorite wiring) ─────────────

describe("AppsView launch + favorite wiring", () => {
  let originalBootConfig: ReturnType<typeof getBootConfig>;

  beforeEach(() => {
    originalBootConfig = getBootConfig();
    // The catalog filter hides any app that is not a configured default (and
    // not an internal tool / curated game). Register our fixture so it passes
    // `filterAppsForCatalog` and reaches the grid.
    setBootConfig({ ...originalBootConfig, defaultApps: [APP_NAME] });
    listAppRuns.mockResolvedValue([]);
    loadAppsCatalog.mockResolvedValue([makeApp()]);
    launchApp.mockResolvedValue({
      pluginInstalled: true,
      needsRestart: false,
      displayName: "Acme Notes",
      launchType: "iframe",
      launchUrl: null,
      viewer: null,
      session: null,
      run: null,
      diagnostics: [],
    });
  });

  afterEach(() => {
    setBootConfig(originalBootConfig);
  });

  function renderView(value: MockAppOptions) {
    return render(
      <MockAppProvider value={value}>
        <AppsView />
      </MockAppProvider>,
    );
  }

  async function findLaunchCard(getByTestId: (id: string) => HTMLElement) {
    await waitFor(() => {
      expect(getByTestId(`app-card-${APP_NAME}`)).not.toBeNull();
    });
    return getByTestId(`app-card-${APP_NAME}`);
  }

  it("launching a plain catalog app calls client.launchApp with the app id", async () => {
    const setState = vi.fn();
    const { getByTestId } = renderView({
      setState,
      favoriteApps: [],
      recentApps: [],
      appRuns: [],
      appsSubTab: "browse",
      activeGameRunId: "",
      activeGameViewerUrl: "",
      walletEnabled: false,
    });

    const card = await findLaunchCard(getByTestId);
    fireEvent.click(card);

    await waitFor(() => {
      expect(launchApp).toHaveBeenCalledWith(APP_NAME);
    });
    expect(launchApp).toHaveBeenCalledTimes(1);
  });

  it("toggling favorite on an un-favorited app persists it via setState", async () => {
    const setState = vi.fn();
    const { getByTestId, getByLabelText } = renderView({
      setState,
      favoriteApps: [],
      recentApps: [],
      appRuns: [],
      appsSubTab: "browse",
      activeGameRunId: "",
      activeGameViewerUrl: "",
      walletEnabled: false,
    });

    await findLaunchCard(getByTestId);
    fireEvent.click(getByLabelText("Add to favorites"));

    expect(setState).toHaveBeenCalledWith("favoriteApps", [APP_NAME]);
    // The favorite path must not launch the app.
    expect(launchApp).not.toHaveBeenCalled();
  });

  it("un-favoriting removes the app id from the persisted favorites list", async () => {
    const setState = vi.fn();
    const { getByTestId, getByLabelText } = renderView({
      setState,
      favoriteApps: [APP_NAME],
      recentApps: [],
      appRuns: [],
      appsSubTab: "browse",
      activeGameRunId: "",
      activeGameViewerUrl: "",
      walletEnabled: false,
    });

    await findLaunchCard(getByTestId);
    fireEvent.click(getByLabelText("Remove from favorites"));

    expect(setState).toHaveBeenCalledWith("favoriteApps", []);
  });

  it("rapid double-click launches twice — the catalog path has no in-flight guard", async () => {
    // Slow launch so both clicks land before the first resolves. handleLaunch
    // has no per-app busy lock for plain catalog apps, so a double-click
    // dispatches two launches. This asserts the CURRENT contract; if a guard is
    // ever added, tighten this to `toHaveBeenCalledTimes(1)`.
    let resolveLaunch: (v: unknown) => void = () => {};
    launchApp.mockImplementation(
      () => new Promise((resolve) => (resolveLaunch = resolve)),
    );
    const setState = vi.fn();
    const { getByTestId } = renderView({
      setState,
      favoriteApps: [],
      recentApps: [],
      appRuns: [],
      appsSubTab: "browse",
      activeGameRunId: "",
      activeGameViewerUrl: "",
      walletEnabled: false,
    });

    const card = await findLaunchCard(getByTestId);
    fireEvent.click(card);
    fireEvent.click(card);

    await waitFor(() => {
      expect(launchApp).toHaveBeenCalledTimes(2);
    });
    expect(launchApp).toHaveBeenNthCalledWith(1, APP_NAME);
    expect(launchApp).toHaveBeenNthCalledWith(2, APP_NAME);
    resolveLaunch({
      pluginInstalled: true,
      needsRestart: false,
      displayName: "Acme Notes",
      launchType: "iframe",
      launchUrl: null,
      viewer: null,
      session: null,
      run: null,
      diagnostics: [],
    });
  });
});
