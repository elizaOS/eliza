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

vi.mock("../../state", () => ({ useApp: () => appMock.value }));
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

beforeEach(() => {
  clientMock.onWsEvent.mockClear();
  clientMock.testPluginConnection.mockReset();
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
});
