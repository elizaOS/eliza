import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseApp = vi.fn();
const mockOnWsEvent = vi.fn(() => () => {});
const mockHandlePluginToggle = vi.fn();
const mockLoadPlugins = vi.fn(async () => {});
const mockHandlePluginConfigSave = vi.fn(async () => {});
const mockSetActionNotice = vi.fn();
const mockSetState = vi.fn();

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    onWsEvent: (...args: unknown[]) => mockOnWsEvent(...args),
    installRegistryPlugin: vi.fn(),
    testPluginConnection: vi.fn(),
    restartAndWait: vi.fn(),
  },
}));

import { PluginsView } from "@elizaos/app-core/components/PluginsView";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function baseContext() {
  return {
    t: (k: string) => k,
    plugins: [
      {
        id: "test-plugin",
        name: "Test Plugin",
        description: "Plugin for toggle UX tests",
        enabled: false,
        configured: true,
        envKey: null,
        category: "feature" as const,
        source: "bundled" as const,
        parameters: [],
        validationErrors: [],
        validationWarnings: [],
      },
    ],
    pluginStatusFilter: "all" as const,
    pluginSearch: "",
    pluginSettingsOpen: new Set<string>(),
    pluginSaving: new Set<string>(),
    pluginSaveSuccess: new Set<string>(),
    loadPlugins: mockLoadPlugins,
    handlePluginToggle: mockHandlePluginToggle,
    handlePluginConfigSave: mockHandlePluginConfigSave,
    setActionNotice: mockSetActionNotice,
    setState: mockSetState,
  };
}

describe("PluginsView restart-aware toggles", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    mockOnWsEvent.mockReset();
    mockHandlePluginToggle.mockReset();
    mockLoadPlugins.mockReset();
    mockHandlePluginConfigSave.mockReset();
    mockSetActionNotice.mockReset();
    mockSetState.mockReset();
    mockOnWsEvent.mockReturnValue(() => {});
    mockLoadPlugins.mockResolvedValue(undefined);
    mockHandlePluginConfigSave.mockResolvedValue(undefined);
    mockSetState.mockImplementation(() => {});
    mockUseApp.mockReturnValue(baseContext());
  });

  it("locks plugin toggles while a restart-causing toggle is in flight", async () => {
    const deferred = createDeferred<void>();
    mockHandlePluginToggle.mockReturnValue(deferred.promise);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(PluginsView));
    });

    const getToggle = () =>
      tree?.root.find(
        (node) =>
          node.type === "button" &&
          node.props["data-plugin-toggle"] === "test-plugin",
      );

    expect(getToggle().props.disabled).toBe(false);

    await act(async () => {
      getToggle().props.onClick({ stopPropagation: () => {} });
    });

    expect(mockHandlePluginToggle).toHaveBeenCalledTimes(1);
    expect(getToggle().props.disabled).toBe(true);
    expect(String(getToggle().props.children)).toContain("APPLYING");
    expect(
      tree?.root.findAll(
        (node) =>
          typeof node.props.className === "string" &&
          node.props.className.includes("border-accent") &&
          node.children.join("").includes("pluginsview.ApplyingPluginChan"),
      ).length,
    ).toBeGreaterThan(0);

    await act(async () => {
      getToggle().props.onClick({ stopPropagation: () => {} });
    });
    expect(mockHandlePluginToggle).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    expect(getToggle().props.disabled).toBe(false);
  });
});
