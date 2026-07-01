// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "../../api";
import { PluginsView } from "./PluginsView";

// PluginsView reads plugin data + lifecycle handlers from the app context
// (useApp), and talks to the runtime directly through `client` (WebSocket
// install-progress events, registry install/test calls). Both are the seams
// the Q2 data-layer refactor reshapes, so we drive the view through mocks of
// each and assert rendered output + handler dispatch.
const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const clientMock = vi.hoisted(() => ({
  onWsEvent: vi.fn(() => () => {}),
  testPluginConnection: vi.fn(),
  installRegistryPlugin: vi.fn(),
  updateRegistryPlugin: vi.fn(),
  uninstallRegistryPlugin: vi.fn(),
  restartAndWait: vi.fn(),
}));

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
  useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
}));
vi.mock("../../api", () => ({ client: clientMock }));

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

function makeContext(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    plugins: [] as PluginInfo[],
    pluginStatusFilter: "all",
    pluginSearch: "",
    pluginSettingsOpen: new Set<string>(),
    pluginSaving: null,
    pluginSaveSuccess: null,
    loadPlugins: vi.fn(async () => {}),
    ensurePluginsLoaded: vi.fn(async () => {}),
    handlePluginToggle: vi.fn(async () => {}),
    handlePluginConfigSave: vi.fn(async () => {}),
    setActionNotice: vi.fn(),
    setState: vi.fn(),
    t,
    ...overrides,
  };
}

function makePlugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "weather",
    name: "Weather Plugin",
    description: "Fetches the weather",
    enabled: true,
    configured: true,
    envKey: null,
    category: "feature",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    ...overrides,
  } as PluginInfo;
}

function makeParam(
  overrides: Partial<Record<string, unknown>> & { key: string },
): Record<string, unknown> {
  return {
    type: "string",
    description: "",
    required: false,
    sensitive: false,
    currentValue: null,
    isSet: false,
    ...overrides,
  };
}

/** jsdom has no real DataTransfer; the drag handlers only need these members. */
function fakeDataTransfer() {
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn(),
    getData: vi.fn(() => ""),
  };
}

function domPluginOrder(): string[] {
  return Array.from(document.querySelectorAll("[data-plugin-id]"))
    .map((el) => el.getAttribute("data-plugin-id"))
    .filter((id): id is string => !!id && id !== "__ui-showcase__");
}

beforeEach(() => {
  clientMock.onWsEvent.mockClear();
  clientMock.testPluginConnection.mockReset();
  localStorage.clear();
  appMock.value = makeContext();
});

afterEach(() => cleanup());

describe("PluginsView", () => {
  it("calls ensurePluginsLoaded on mount and renders the catalog without any real plugin cards", async () => {
    render(<PluginsView />);

    await waitFor(() => {
      expect(appMock.value.ensurePluginsLoaded).toHaveBeenCalled();
    });
    // The catalog page mounts; with no context plugins, no real plugin card
    // (e.g. the Weather fixture) is present — only the built-in UI showcase.
    expect(screen.getByTestId("plugins-view-page")).toBeTruthy();
    expect(screen.queryByText("Weather Plugin")).toBeNull();
  });

  it("renders a plugin card once the context provides plugins", () => {
    appMock.value = makeContext({ plugins: [makePlugin()] });

    render(<PluginsView />);

    expect(screen.getByText("Weather Plugin")).toBeTruthy();
    expect(screen.queryByText("Nothing to show")).toBeNull();
  });

  it("does not render raw emoji icon strings from plugin metadata", () => {
    appMock.value = makeContext({
      plugins: [
        makePlugin({
          icon: "🔌",
          iconName: "Puzzle",
        } as Partial<PluginInfo>),
      ],
    });

    render(<PluginsView />);

    expect(screen.getByText("Weather Plugin")).toBeTruthy();
    expect(screen.queryByText("🔌")).toBeNull();
  });

  it("clicking a plugin's enable toggle dispatches handlePluginToggle with the inverted state", async () => {
    const plugin = makePlugin({ enabled: true });
    appMock.value = makeContext({ plugins: [plugin] });

    render(<PluginsView />);

    const toggle = document.querySelector('[data-plugin-toggle="weather"]');
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle as Element);

    await waitFor(() => {
      expect(appMock.value.handlePluginToggle).toHaveBeenCalledWith(
        "weather",
        false,
      );
    });
  });

  it("subscribes to install-progress WebSocket events on mount", () => {
    render(<PluginsView />);

    expect(clientMock.onWsEvent).toHaveBeenCalledWith(
      "install-progress",
      expect.any(Function),
    );
  });

  // Regression: the real `ensurePluginsLoaded` from useApp() is a useCallback
  // whose identity changes whenever the `pluginsLoaded` flag flips (it lists
  // pluginsLoaded as a dep). Before the fix, the mount effect depended on that
  // callback's identity, so each identity change re-fired the effect — and,
  // combined with context-driven re-renders, this loaded plugins on a loop and
  // tripped the render guard ("Loading…" storm). The mount load must run once
  // regardless of how many times the callback identity changes or the tree
  // re-renders.
  it("loads plugins exactly once even when ensurePluginsLoaded identity churns across re-renders", async () => {
    const ensureCalls = { count: 0 };
    // Each render hands PluginsView a brand-new ensurePluginsLoaded, mimicking
    // the unstable useCallback identity in the real app context.
    const makeUnstableContext = () =>
      makeContext({
        ensurePluginsLoaded: vi.fn(async () => {
          ensureCalls.count += 1;
        }),
      });

    appMock.value = makeUnstableContext();
    const view = render(<PluginsView />);

    await waitFor(() => {
      expect(ensureCalls.count).toBe(1);
    });

    // Force several re-renders with fresh callback identities. The one-shot
    // guard must prevent any additional invocations.
    for (let i = 0; i < 5; i += 1) {
      appMock.value = makeUnstableContext();
      view.rerender(<PluginsView />);
    }

    // Let any (incorrectly-armed) effects flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ensureCalls.count).toBe(1);
  });

  // ── Enable/disable idempotency ─────────────────────────────────────────
  it("dispatches handlePluginToggle exactly once for a rapid triple-click while a toggle is in flight", async () => {
    // A deferred that never resolves keeps the toggle "in flight" for the whole
    // test, so the in-flight guard (togglingPlugins) must swallow clicks 2 & 3.
    let resolveToggle: (() => void) | undefined;
    const toggleGate = new Promise<void>((resolve) => {
      resolveToggle = resolve;
    });
    const handlePluginToggle = vi.fn(async () => {
      await toggleGate;
    });
    appMock.value = makeContext({
      plugins: [makePlugin({ id: "weather", enabled: true })],
      handlePluginToggle,
    });

    render(<PluginsView />);

    const toggle = document.querySelector(
      '[data-plugin-toggle="weather"]',
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(handlePluginToggle).toHaveBeenCalledTimes(1);
    });
    // Only one write, and it flips the current (enabled) state to disabled.
    expect(handlePluginToggle).toHaveBeenCalledTimes(1);
    expect(handlePluginToggle).toHaveBeenCalledWith("weather", false);
    // The in-flight button is disabled — no second write can be queued.
    expect(toggle.disabled).toBe(true);
    resolveToggle?.();
  });

  // ── Config save persistence + clear-after-save ─────────────────────────
  it("saves the edited plugin config through the settings dialog and clears the draft after save", async () => {
    const handlePluginConfigSave = vi.fn(async () => {});
    appMock.value = makeContext({
      plugins: [
        makePlugin({
          id: "weather",
          parameters: [makeParam({ key: "NICKNAME" })],
        } as Partial<PluginInfo>),
      ],
      // The dialog reads these as Sets (pluginSaving.has / pluginSaveSuccess.has).
      pluginSaving: new Set<string>(),
      pluginSaveSuccess: new Set<string>(),
      pluginSettingsOpen: new Set<string>(["weather"]),
      handlePluginConfigSave,
    });

    render(<PluginsView />);

    // The config renderer emits a text input tagged with the param key.
    const input = document.querySelector(
      '[data-config-key="NICKNAME"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: "Stormy" } });

    const saveBtn = screen.getByRole("button", { name: /save settings/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(handlePluginConfigSave).toHaveBeenCalledWith("weather", {
        NICKNAME: "Stormy",
      });
    });

    // The draft is deleted after a successful save: a second save with no
    // further edits must send an empty config (proving no stale/duplicate draft
    // is re-submitted).
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(handlePluginConfigSave).toHaveBeenCalledTimes(2);
    });
    expect(handlePluginConfigSave).toHaveBeenLastCalledWith("weather", {});
  });

  // ── Search / filter ────────────────────────────────────────────────────
  it("renders only plugins matching the active search query", () => {
    appMock.value = makeContext({
      pluginSearch: "weather",
      plugins: [
        makePlugin({ id: "weather", name: "Weather Plugin", group: "voice" }),
        makePlugin({
          id: "spotify",
          name: "Spotify Plugin",
          description: "Plays music",
          group: "voice",
        }),
      ] as PluginInfo[],
    });

    render(<PluginsView />);

    expect(screen.getByText("Weather Plugin")).toBeTruthy();
    expect(screen.queryByText("Spotify Plugin")).toBeNull();
  });

  it("renders only disabled plugins when the status filter is 'disabled'", () => {
    appMock.value = makeContext({
      pluginStatusFilter: "disabled",
      plugins: [
        makePlugin({
          id: "weather",
          name: "Weather Plugin",
          enabled: true,
          group: "voice",
        }),
        makePlugin({
          id: "spotify",
          name: "Spotify Plugin",
          enabled: false,
          group: "voice",
        }),
      ] as PluginInfo[],
    });

    render(<PluginsView />);

    expect(screen.getByText("Spotify Plugin")).toBeTruthy();
    expect(screen.queryByText("Weather Plugin")).toBeNull();
  });

  // ── Drag reorder handler ───────────────────────────────────────────────
  it("reorders the visible list and persists custom order when a card is dropped onto another", async () => {
    appMock.value = makeContext({
      plugins: [
        makePlugin({ id: "a", name: "Alpha", group: "voice" }),
        makePlugin({ id: "b", name: "Bravo", group: "voice" }),
        makePlugin({ id: "c", name: "Charlie", group: "voice" }),
      ] as PluginInfo[],
    });

    render(<PluginsView />);

    // Default sort is alphabetical by name.
    expect(domPluginOrder()).toEqual(["a", "b", "c"]);

    const cardC = document.querySelector('[data-plugin-id="c"]') as Element;
    const cardA = document.querySelector('[data-plugin-id="a"]') as Element;
    const dt = fakeDataTransfer();
    fireEvent.dragStart(cardC, { dataTransfer: dt });
    fireEvent.dragOver(cardA, { dataTransfer: dt });
    fireEvent.drop(cardA, { dataTransfer: dt });

    // The dropped card moves to the target's index; the list re-renders.
    await waitFor(() => {
      expect(domPluginOrder()).toEqual(["c", "a", "b"]);
    });

    const persisted: string[] = JSON.parse(
      localStorage.getItem("pluginOrder") ?? "[]",
    );
    expect(persisted.filter((id) => id !== "__ui-showcase__")).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  // ── Reset order ────────────────────────────────────────────────────────
  it("reset-order restores the default sort and clears the persisted order", () => {
    // Seed a custom order that inverts the default alphabetical sort.
    localStorage.setItem("pluginOrder", JSON.stringify(["c", "b", "a"]));
    appMock.value = makeContext({
      plugins: [
        makePlugin({ id: "a", name: "Alpha", group: "voice" }),
        makePlugin({ id: "b", name: "Bravo", group: "voice" }),
        makePlugin({ id: "c", name: "Charlie", group: "voice" }),
      ] as PluginInfo[],
    });

    render(<PluginsView />);

    // Seeded custom order is honored on mount.
    expect(domPluginOrder()).toEqual(["c", "b", "a"]);

    const resetBtn = screen.getByText("pluginsview.ResetOrder");
    fireEvent.click(resetBtn);

    // Order reverts to the default sort and the persisted key is removed.
    expect(domPluginOrder()).toEqual(["a", "b", "c"]);
    expect(localStorage.getItem("pluginOrder")).toBeNull();
    // With no custom order the reset affordance disappears.
    expect(screen.queryByText("pluginsview.ResetOrder")).toBeNull();
  });
});
