// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithCsrf } from "../../api/csrf-client";
import {
  registerDynamicView,
  unregisterDynamicView,
} from "../../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { useAvailableViews } from "../../hooks/useAvailableViews";
import { useViewCatalog } from "../../hooks/useViewCatalog";
import { getActiveViewModality } from "../../platform/platform-guards";
import { SPRINGBOARD_STORAGE_KEY } from "../../state/springboard-layout";
import { useIsDeveloperMode } from "../../state/useDeveloperMode";
import {
  useViewChatBinding,
  type ViewChatBinding,
} from "../../state/view-chat-binding";
import { ViewCatalog } from "./ViewCatalog";

vi.mock("../../hooks/useAvailableViews", () => ({
  useAvailableViews: vi.fn(),
}));

vi.mock("../../hooks/useViewCatalog", () => ({
  useViewCatalog: vi.fn(),
}));

vi.mock("../../platform/platform-guards", () => ({
  getActiveViewModality: vi.fn(() => "gui"),
}));

vi.mock("../../state/useDeveloperMode", () => ({
  useIsDeveloperMode: vi.fn(),
}));

vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: vi.fn(() => true),
}));

vi.mock("../../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));

vi.mock("../../bridge/electrobun-rpc", () => ({
  registerDynamicView: vi.fn(),
  unregisterDynamicView: vi.fn(),
}));

const isElectrobunRuntimeMock = vi.mocked(isElectrobunRuntime);
const useAvailableViewsMock = vi.mocked(useAvailableViews);
const useViewCatalogMock = vi.mocked(useViewCatalog);
const useIsDeveloperModeMock = vi.mocked(useIsDeveloperMode);
const getActiveViewModalityMock = vi.mocked(getActiveViewModality);
const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);
const registerDynamicViewMock = vi.mocked(registerDynamicView);
const unregisterDynamicViewMock = vi.mocked(unregisterDynamicView);

function view(
  id: string,
  overrides: Partial<ViewRegistryEntry> = {},
): ViewRegistryEntry {
  return {
    id,
    label: id,
    available: true,
    pluginName: "core",
    builtin: false,
    tags: [],
    ...overrides,
  };
}

const views: ViewRegistryEntry[] = [
  view("views-manager", {
    label: "Views",
    description: "Browse and open available views contributed by plugins",
    path: "/views",
    pluginName: "app-control",
    builtin: false,
    tags: ["views"],
  }),
  view("local.notes", {
    label: "Local Notes",
    description: "Built-in local note board",
    path: "/apps/local-notes",
    pluginName: "core",
    builtin: true,
    tags: ["local", "notes"],
  }),
  view("chat", {
    label: "Chat",
    description: "Conversations with your agent",
    path: "/chat",
    pluginName: "@elizaos/builtin",
    builtin: true,
    tags: ["chat", "messages"],
  }),
  view("character", {
    label: "Character",
    description: "Agent identity and knowledge documents",
    path: "/character",
    pluginName: "@elizaos/builtin/character",
    builtin: true,
    tags: ["character", "identity"],
  }),
  view("remote.ledger", {
    label: "Remote Ledger",
    description: "Remote module loaded from a plugin bundle",
    path: "/apps/remote-ledger",
    bundleUrl: "/api/views/remote.ledger/bundle.js",
    pluginName: "ledger-plugin",
    builtin: false,
    tags: ["remote", "finance"],
    desktopTabEnabled: true,
  }),
  view("developer.trace", {
    label: "Developer Trace",
    description: "Developer-only diagnostics view",
    path: "/apps/developer-trace",
    pluginName: "trace-plugin",
    developerOnly: true,
  }),
  view("internal.hidden", {
    label: "Internal Hidden",
    path: "/apps/internal-hidden",
    pluginName: "internal-plugin",
    visibleInManager: false,
  }),
];

// ViewCatalog moved its search box into the global floating chat composer
// (#8597): instead of rendering a standalone <input>, it registers a
// ViewChatBinding (placeholder + onQuery) that the composer drives. This probe
// captures the active binding so tests can assert the search placeholder and
// feed queries exactly the way the chat composer does.
let activeChatBinding: ViewChatBinding | null = null;
function ChatBindingProbe(): null {
  activeChatBinding = useViewChatBinding();
  return null;
}
function renderCatalog(): ReturnType<typeof render> {
  return render(
    <>
      <ViewCatalog />
      <ChatBindingProbe />
    </>,
  );
}

describe("ViewCatalog", () => {
  beforeEach(() => {
    activeChatBinding = null;
    window.history.replaceState(null, "", "/views");
    window.localStorage.clear();
    useAvailableViewsMock.mockReturnValue({
      views,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    useIsDeveloperModeMock.mockReturnValue(false);
    isElectrobunRuntimeMock.mockReturnValue(true);
    getActiveViewModalityMock.mockReturnValue("gui");
    useViewCatalogMock.mockReturnValue({
      entries: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
      get: vi.fn(),
    });
    fetchWithCsrfMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    } as Response);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("lists local and remote module views while hiding internal and developer-only views by default", () => {
    renderCatalog();

    expect(screen.getByRole("heading", { name: "Views" })).toBeTruthy();
    expect(activeChatBinding?.placeholder).toBe("Search views…");
    expect(screen.getByText("Local Notes")).toBeTruthy();
    expect(screen.getByText("Remote Ledger")).toBeTruthy();
    expect(screen.queryByTestId("view-card-views-manager")).toBeNull();
    expect(screen.queryByTestId("view-card-chat")).toBeNull();
    expect(screen.queryByTestId("view-card-character")).toBeNull();
    expect(screen.queryByText("Developer Trace")).toBeNull();
    expect(screen.queryByText("Internal Hidden")).toBeNull();
  });

  it("shows developer-only views when developer mode is enabled", () => {
    useIsDeveloperModeMock.mockReturnValue(true);

    render(<ViewCatalog />);

    expect(screen.getByText("Developer Trace")).toBeTruthy();
    expect(screen.queryByText("Internal Hidden")).toBeNull();
  });

  it("opens a view through the actual rendered springboard tile", () => {
    render(<ViewCatalog />);

    fireEvent.click(screen.getByRole("button", { name: "Remote Ledger" }));

    expect(window.location.pathname).toBe("/apps/remote-ledger");
  });

  it("falls back to Springboard local favorites when off the Electrobun desktop shell", () => {
    // useDesktopTabs is inert off-desktop, so the controlled favorites dock
    // would be permanently empty. Off-Electrobun the catalog must omit the
    // controlled props and let Springboard manage favorites locally.
    isElectrobunRuntimeMock.mockReturnValue(false);

    render(<ViewCatalog />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByTestId("springboard-fav-local.notes"));

    const stored = JSON.parse(
      window.localStorage.getItem(SPRINGBOARD_STORAGE_KEY) ?? "{}",
    );
    expect(stored.favorites).toContain("local.notes");
  });

  it("hides TUI and XR views entirely on a GUI surface", () => {
    getActiveViewModalityMock.mockReturnValue("gui");
    useAvailableViewsMock.mockReturnValue({
      views: [
        view("dash", { label: "Dashboard", path: "/apps/dash" }),
        view("term", {
          label: "Terminal Only",
          path: "/apps/term",
          viewType: "tui",
        }),
        view("space", {
          label: "Spatial Only",
          path: "/apps/space",
          viewType: "xr",
        }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<ViewCatalog />);

    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.queryByText("Terminal Only")).toBeNull();
    expect(screen.queryByText("Spatial Only")).toBeNull();
    expect(screen.queryByTestId("view-card-term")).toBeNull();
    expect(screen.queryByTestId("view-card-space")).toBeNull();
  });

  it("shows only XR views when running in an XR surface", () => {
    getActiveViewModalityMock.mockReturnValue("xr");
    useAvailableViewsMock.mockReturnValue({
      views: [
        view("dash", { label: "Dashboard GUI", path: "/apps/dash" }),
        view("term", {
          label: "Terminal TUI",
          path: "/apps/term",
          viewType: "tui",
        }),
        view("space", {
          label: "Spatial XR",
          path: "/apps/space",
          viewType: "xr",
        }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<ViewCatalog />);

    expect(screen.getByText("Spatial XR")).toBeTruthy();
    expect(screen.getByTestId("springboard-tile-space")).toBeTruthy();
    expect(screen.queryByText("Dashboard GUI")).toBeNull();
    expect(screen.queryByText("Terminal TUI")).toBeNull();
  });

  it("renders springboard tiles as icon + name only, hiding raw metadata (description, tags)", () => {
    getActiveViewModalityMock.mockReturnValue("gui");
    useAvailableViewsMock.mockReturnValue({
      views: [
        view("withhero", {
          label: "With Hero",
          path: "/apps/withhero",
          heroImageUrl: "/api/views/withhero/hero",
          hasHeroImage: true,
          description: "visible description",
          tags: ["hiddentag"],
        }),
        view("nohero", {
          label: "No Hero",
          path: "/apps/nohero",
          icon: "Wallet",
          heroImageUrl: "/api/views/nohero/hero",
          hasHeroImage: false,
          description: "also visible",
        }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<ViewCatalog />);

    // iOS-like springboard: each view is a tile with the app name below the
    // icon. No hero images, no descriptions, no raw tags.
    expect(screen.getByTestId("springboard-tile-withhero")).toBeTruthy();
    expect(screen.getByTestId("springboard-tile-nohero")).toBeTruthy();
    expect(screen.getByText("With Hero")).toBeTruthy();
    expect(screen.getByText("No Hero")).toBeTruthy();
    expect(screen.queryByText("visible description")).toBeNull();
    expect(screen.queryByText("also visible")).toBeNull();
    expect(screen.queryByText("hiddentag")).toBeNull();
  });

  it("lists not-loaded catalog apps in a Get section and triggers get() on click", () => {
    const get = vi.fn();
    useViewCatalogMock.mockReturnValue({
      entries: [
        {
          key: "app:@elizaos/plugin-clawville",
          id: "@elizaos/plugin-clawville",
          label: "ClawVille",
          hasHero: true,
          heroUrl: "/api/apps/hero/clawville",
          modality: "gui",
          state: "available",
          kind: "app",
          appName: "@elizaos/plugin-clawville",
        },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
      get,
    });

    render(<ViewCatalog />);

    expect(screen.getByTestId("views-catalog-section")).toBeTruthy();
    expect(screen.getByText("ClawVille")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Get ClawVille"));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("favorites a view into the dock (= pinning a desktop tab) without navigating", () => {
    render(<ViewCatalog />);

    // Enter springboard edit mode, then favorite Remote Ledger.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByTestId("springboard-fav-remote.ledger"));

    // Favoriting pins it as a desktop tab; no navigation occurs.
    expect(window.location.pathname).toBe("/views");
    const pinned = JSON.parse(
      window.localStorage.getItem("elizaos.desktop.pinned-tabs") ?? "[]",
    ) as Array<{ viewId: string }>;
    expect(pinned.some((t) => t.viewId === "remote.ledger")).toBe(true);
    // The favorited view now appears in the dock.
    const dock = screen.getByTestId("springboard-dock");
    expect(dock.textContent).toContain("Remote Ledger");
  });

  it("shows pinned and recent views as quick access without duplicates", () => {
    useIsDeveloperModeMock.mockReturnValue(true);
    const manyViews = [
      ...views,
      ...Array.from({ length: 10 }, (_, index) =>
        view(`plugin.${index}`, {
          label: `Plugin ${index}`,
          path: `/apps/plugin-${index}`,
          pluginName: "plugin-pack",
        }),
      ),
    ];
    useAvailableViewsMock.mockReturnValue({
      views: manyViews,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    window.localStorage.setItem(
      "elizaos.desktop.pinned-tabs",
      JSON.stringify([
        {
          viewId: "remote.ledger",
          label: "Remote Ledger",
          path: "/apps/remote-ledger",
          pinned: true,
        },
      ]),
    );
    window.localStorage.setItem(
      "elizaos.views.recent",
      JSON.stringify([
        "remote.ledger",
        "plugin.0",
        "plugin.1",
        "plugin.2",
        "plugin.3",
        "plugin.4",
        "plugin.5",
        "plugin.6",
        "plugin.7",
        "plugin.8",
      ]),
    );

    render(<ViewCatalog />);

    // A pinned desktop tab surfaces in the springboard favorites dock and is
    // not duplicated in the page grid (favorites are excluded from pages).
    const dock = screen.getByTestId("springboard-dock");
    expect(dock.textContent).toContain("Remote Ledger");
    expect(screen.getAllByText("Remote Ledger")).toHaveLength(1);
    expect(screen.queryByTestId("springboard-tile-remote.ledger")).toBeTruthy();
    // Other views still render as page tiles.
    expect(screen.getByTestId("springboard-tile-plugin.0")).toBeTruthy();
  });

  it("sorts cards alphabetically when A-Z is selected", () => {
    useAvailableViewsMock.mockReturnValue({
      views: [
        view("plugin.z", {
          label: "Zebra",
          path: "/apps/zebra",
          pluginName: "plugin-pack",
        }),
        view("plugin.a", {
          label: "Alpha",
          path: "/apps/alpha",
          pluginName: "plugin-pack",
        }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const { container } = render(<ViewCatalog />);

    fireEvent.click(screen.getByRole("button", { name: "A-Z" }));

    const pluginTiles = Array.from(
      container.querySelectorAll('[data-testid^="springboard-tile-plugin."]'),
    );
    expect(pluginTiles.map((tile) => tile.getAttribute("data-testid"))).toEqual(
      ["springboard-tile-plugin.a", "springboard-tile-plugin.z"],
    );
  });

  it("uses the search input to render server-ranked remote results", async () => {
    vi.useFakeTimers();
    fetchWithCsrfMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          view("remote.ledger", {
            label: "Remote Ledger",
            description: "Remote module loaded from a plugin bundle",
            path: "/apps/remote-ledger",
            bundleUrl: "/api/views/remote.ledger/bundle.js",
            pluginName: "ledger-plugin",
            tags: ["remote", "finance"],
          }),
        ],
      }),
    } as Response);

    renderCatalog();

    act(() => {
      activeChatBinding?.onQuery?.("ledger");
    });

    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });

    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/views/search?q=ledger&limit=10",
    );
    expect(screen.getByText("Remote Ledger")).toBeTruthy();
    expect(screen.queryByText("Local Notes")).toBeNull();
  });

  it("creates, edits, and deletes dynamic views through the rendered management controls", async () => {
    useIsDeveloperModeMock.mockReturnValue(true);
    let currentViews = [...views];
    const refresh = vi.fn(async () => undefined);
    useAvailableViewsMock.mockImplementation(() => ({
      views: currentViews,
      loading: false,
      error: null,
      refresh,
    }));
    registerDynamicViewMock.mockImplementation(async (manifest) => {
      currentViews = [
        ...currentViews.filter((entry) => entry.id !== manifest.id),
        view(manifest.id, {
          label: manifest.title,
          description: manifest.description,
          path: `/apps/${manifest.id}`,
          bundleUrl: manifest.entrypoint,
          pluginName: "developer",
          tags: ["developer"],
        }),
      ];
      return manifest;
    });
    unregisterDynamicViewMock.mockImplementation(async (viewId) => {
      const before = currentViews.length;
      currentViews = currentViews.filter((entry) => entry.id !== viewId);
      return { removed: currentViews.length !== before };
    });

    const { rerender } = render(<ViewCatalog />);

    fireEvent.change(screen.getByLabelText("Dynamic view ID"), {
      target: { value: "developer.ledger" },
    });
    fireEvent.change(screen.getByLabelText("Dynamic view title"), {
      target: { value: "Developer Ledger" },
    });
    fireEvent.change(screen.getByLabelText("Dynamic view entrypoint"), {
      target: { value: "/dynamic-views/developer-ledger.js" },
    });
    fireEvent.change(screen.getByLabelText("Dynamic view description"), {
      target: { value: "Created from the View Manager" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(registerDynamicViewMock).toHaveBeenCalledWith(
        {
          id: "developer.ledger",
          title: "Developer Ledger",
          description: "Created from the View Manager",
          source: "developer",
          entrypoint: "/dynamic-views/developer-ledger.js",
          placement: "canvas",
          metadata: { managedBy: "view-manager" },
        },
        { update: true },
      );
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender(<ViewCatalog />);
    expect(screen.getByText("Developer Ledger")).toBeTruthy();

    // Per-tile edit/delete affordances live in springboard edit mode.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Developer Ledger" }),
    );
    expect(
      (screen.getByLabelText("Dynamic view ID") as HTMLInputElement).value,
    ).toBe("developer.ledger");
    expect(
      (screen.getByLabelText("Dynamic view entrypoint") as HTMLInputElement)
        .value,
    ).toBe("/dynamic-views/developer-ledger.js");

    fireEvent.change(screen.getByLabelText("Dynamic view title"), {
      target: { value: "Developer Ledger Updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(registerDynamicViewMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: "developer.ledger",
          title: "Developer Ledger Updated",
        }),
        { update: true },
      );
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    rerender(<ViewCatalog />);
    expect(screen.getByText("Developer Ledger Updated")).toBeTruthy();
    expect(screen.queryByText("Developer Ledger")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete Developer Ledger Updated" }),
    );

    await waitFor(() => {
      expect(unregisterDynamicViewMock).toHaveBeenCalledWith(
        "developer.ledger",
      );
    });
    expect(refresh).toHaveBeenCalledTimes(3);
    rerender(<ViewCatalog />);
    expect(screen.queryByText("Developer Ledger Updated")).toBeNull();
    expect(screen.getByText("Local Notes")).toBeTruthy();
    // Three register/edit/delete round-trips with waitFor — give it headroom
    // so it doesn't flake on the default 5s timeout under heavy machine load.
  }, 30000);
});
