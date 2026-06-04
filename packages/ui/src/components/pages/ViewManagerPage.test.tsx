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
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { useAvailableViews } from "../../hooks/useAvailableViews";
import { useIsDeveloperMode } from "../../state/useDeveloperMode";
import { ViewManagerPage } from "./ViewManagerPage";

vi.mock("../../hooks/useAvailableViews", () => ({
  useAvailableViews: vi.fn(),
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

const useAvailableViewsMock = vi.mocked(useAvailableViews);
const useIsDeveloperModeMock = vi.mocked(useIsDeveloperMode);
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

describe("ViewManagerPage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/views");
    window.localStorage.clear();
    useAvailableViewsMock.mockReturnValue({
      views,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    useIsDeveloperModeMock.mockReturnValue(false);
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
    render(<ViewManagerPage />);

    expect(screen.getByRole("heading", { name: "Views" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search views…")).toBeTruthy();
    expect(screen.getByText("Local Notes")).toBeTruthy();
    expect(screen.getByText("Remote Ledger")).toBeTruthy();
    expect(screen.queryByTestId("view-card-views-manager")).toBeNull();
    expect(screen.queryByText("Developer Trace")).toBeNull();
    expect(screen.queryByText("Internal Hidden")).toBeNull();
  });

  it("shows developer-only views when developer mode is enabled", () => {
    useIsDeveloperModeMock.mockReturnValue(true);

    render(<ViewManagerPage />);

    expect(screen.getByText("Developer Trace")).toBeTruthy();
    expect(screen.queryByText("Internal Hidden")).toBeNull();
  });

  it("opens a view through the actual rendered view card", () => {
    render(<ViewManagerPage />);

    fireEvent.click(screen.getByText("Remote Ledger"));

    expect(window.location.pathname).toBe("/apps/remote-ledger");
  });

  it("renders compact context-rich view cards without hero images", () => {
    render(<ViewManagerPage />);

    const card = screen.getByTestId("view-card-remote.ledger");
    const contextButton = card.querySelector("[data-view-context]");
    const context = JSON.parse(
      contextButton?.getAttribute("data-view-context") ?? "{}",
    );

    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector("svg")).toBeTruthy();
    expect(card.textContent).not.toContain("RLR");
    expect(card.textContent).toContain("ledger-plugin");
    expect(card.textContent).toContain("/apps/remote-ledger");
    expect(context).toMatchObject({
      id: "remote.ledger",
      label: "Remote Ledger",
      pluginName: "ledger-plugin",
      route: "/apps/remote-ledger",
      viewType: "gui",
      status: "available",
    });
    expect(context.agentDescription).toContain("Purpose:");
  });

  it("renders chat-specific suggestion chips for hover and focus discovery", () => {
    render(<ViewManagerPage />);

    const chatCard = screen.getByTestId("view-card-chat");
    const suggestions = screen.getByTestId("chat-view-suggestions");

    expect(suggestions.getAttribute("data-state")).toBe("closed");
    fireEvent.mouseEnter(chatCard);

    expect(suggestions.getAttribute("data-state")).toBe("open");
    expect(chatCard.textContent).toContain("Chat suggestions");
    expect(suggestions.textContent).toContain("Summarize recent messages");
    expect(chatCard.textContent).not.toContain("RLR");
  });

  it("groups GUI, XR, and TUI variants into one launcher row with mode buttons", () => {
    useAvailableViewsMock.mockReturnValue({
      views: [
        ...views,
        view("remote.ledger", {
          label: "Remote Ledger XR",
          description: "Remote module loaded from a plugin bundle",
          path: "/apps/remote-ledger",
          viewType: "xr",
          pluginName: "ledger-plugin",
          tags: ["remote", "finance"],
        }),
        view("remote.ledger", {
          label: "Remote Ledger TUI",
          description: "Terminal ledger controls",
          path: "/apps/remote-ledger/tui",
          viewType: "tui",
          pluginName: "ledger-plugin",
          tags: ["remote", "finance", "terminal"],
        }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<ViewManagerPage />);

    expect(screen.getAllByTestId("view-card-remote.ledger")).toHaveLength(1);
    const card = screen.getByTestId("view-card-remote.ledger");
    expect(card.textContent).toContain("Remote Ledger");
    expect(card.textContent).not.toContain("Remote Ledger XR");
    expect(card.textContent).not.toContain("Remote Ledger TUI");

    fireEvent.click(
      screen.getByRole("button", { name: "Open Remote Ledger TUI" }),
    );

    expect(window.location.pathname).toBe("/apps/remote-ledger/tui");
  });

  it("pins a remote view through the actual pin button without navigating", () => {
    const events: CustomEvent[] = [];
    const listener = (event: Event) => {
      events.push(event as CustomEvent);
    };
    window.addEventListener("eliza:navigate:view", listener);

    render(<ViewManagerPage />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Pin Remote Ledger as desktop tab",
      }),
    );

    expect(window.location.pathname).toBe("/views");
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({
      viewId: "remote.ledger",
      viewPath: "/apps/remote-ledger",
      viewLabel: "Remote Ledger",
      action: "pin-tab",
    });

    window.removeEventListener("eliza:navigate:view", listener);
  });

  it("shows pinned and recent views as the featured launcher without duplicates", () => {
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

    render(<ViewManagerPage />);

    const topSection = screen.getByTestId("views-top-section");
    expect(topSection.textContent).toContain("Remote Ledger");
    expect(topSection.textContent).toContain("Plugin 0");
    expect(topSection.textContent).toContain("Plugin 2");
    expect(topSection.textContent).not.toContain("Plugin 3");
    expect(
      topSection.querySelectorAll('[data-testid^="view-card-"]'),
    ).toHaveLength(4);
    expect(screen.getAllByTestId("view-card-remote.ledger")).toHaveLength(1);
    expect(screen.getAllByText("Remote Ledger")).toHaveLength(1);
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

    render(<ViewManagerPage />);

    fireEvent.change(screen.getByPlaceholderText("Search views…"), {
      target: { value: "ledger" },
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

    const { rerender } = render(<ViewManagerPage />);

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
    rerender(<ViewManagerPage />);
    expect(screen.getByText("Developer Ledger")).toBeTruthy();

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
    rerender(<ViewManagerPage />);
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
    rerender(<ViewManagerPage />);
    expect(screen.queryByText("Developer Ledger Updated")).toBeNull();
    expect(screen.getByText("Local Notes")).toBeTruthy();
  });
});
