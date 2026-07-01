// @vitest-environment jsdom

/**
 * Render-level regression tests for the connector card's config/setup-panel
 * composition (#10705).
 *
 * The regression: when a connector mode delegates its setup panel to a
 * *different* plugin id (`setupPanelPluginId !== plugin.id` — e.g. signal's
 * default plugin-managed mode → `connector-account-management:signal:signal`,
 * or discord's local mode → `discordlocal`), the old predicate dropped the
 * plugin's own config form and rendered only the panel. Both must co-render.
 *
 * `ConnectorSetupPanel` is stubbed at the module seam (it fetches accounts /
 * device state over the API); the stub mirrors the real component's contract
 * by rendering only when `hasConnectorSetupPanel` (real helper) says a panel
 * exists for the id. Everything else — mode resolution, the predicate, the
 * real `PluginConfigForm`/`ConfigRenderer` — renders for real.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo, PluginParamDef } from "../../api";

const stateMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../../state", () => ({
  useApp: () => stateMock.value,
  useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(stateMock.value),
  useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(stateMock.value),
}));

vi.mock("../../api", () => ({ client: {} }));

vi.mock("../connectors/ConnectorSetupPanel", async () => {
  const helpers = await vi.importActual<
    typeof import("../connectors/ConnectorSetupPanel.helpers")
  >("../connectors/ConnectorSetupPanel.helpers");
  return {
    ConnectorSetupPanel: ({ pluginId }: { pluginId: string }) =>
      helpers.hasConnectorSetupPanel(pluginId) ? (
        <div data-testid="connector-setup-panel" data-plugin-id={pluginId} />
      ) : null,
  };
});

import { ConnectorPluginGroups } from "./plugin-view-connectors";

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

function makeParam(key: string): PluginParamDef {
  return {
    key,
    type: "string",
    description: `${key} credential`,
    required: true,
    sensitive: false,
    currentValue: null,
    isSet: false,
  };
}

function makePlugin(overrides: Partial<PluginInfo>): PluginInfo {
  return {
    id: "signal",
    name: "Signal",
    description: "Signal connector",
    enabled: true,
    isActive: true,
    configured: false,
    envKey: null,
    category: "connector",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    ...overrides,
  } as PluginInfo;
}

function makeGroupProps(plugin: PluginInfo) {
  return {
    collapseLabel: "Collapse",
    connectorExpandedIds: new Set([plugin.id]),
    connectorInstallPrompt: "Install this connector",
    connectorSelectedId: null,
    expandLabel: "Expand",
    formatSaveSettingsLabel: (isSaving: boolean) =>
      isSaving ? "Saving..." : "Save",
    formatTestConnectionLabel: () => "Test connection",
    handleConfigReset: vi.fn(),
    handleConfigSave: vi.fn(async () => {}),
    handleConnectorExpandedChange: vi.fn(),
    handleConnectorSectionToggle: vi.fn(),
    handleInstallPlugin: vi.fn(async () => {}),
    handleOpenPluginExternalUrl: vi.fn(async () => {}),
    handleParamChange: vi.fn(),
    handleTestConnection: vi.fn(async () => {}),
    handleTogglePlugin: vi.fn(async () => {}),
    hasPluginToggleInFlight: false,
    installPluginLabel: "Install",
    installProgress: new Map<string, { message: string; phase: string }>(),
    installingPlugins: new Set<string>(),
    installProgressLabel: () => "Installing...",
    loadFailedLabel: "Load failed",
    needsSetupLabel: "Needs setup",
    noConfigurationNeededLabel: "No configuration needed",
    notInstalledLabel: "Not installed",
    pluginConfigs: {},
    pluginDescriptionFallback: "Connector plugin",
    pluginSaveSuccess: new Set<string>(),
    pluginSaving: new Set<string>(),
    readyLabel: "Ready",
    registerConnectorContentItem: () => () => {},
    renderResolvedIcon: () => null,
    t,
    testResults: new Map(),
    togglingPlugins: new Set<string>(),
    visiblePlugins: [plugin],
  };
}

function configField(pluginId: string, key: string): HTMLElement | null {
  return document.getElementById(`field-${pluginId}-${key}`);
}

beforeEach(() => {
  stateMock.value = {
    elizaCloudConnected: false,
    setActionNotice: vi.fn(),
    setState: vi.fn(),
    setTab: vi.fn(),
    t,
  };
});

afterEach(() => {
  cleanup();
});

describe("ConnectorPluginCard config/setup-panel co-rendering", () => {
  it("mounts BOTH the config form and the delegated setup panel when the default mode's setupPanelPluginId differs from plugin.id (signal → connector-account-management)", () => {
    const plugin = makePlugin({
      id: "signal",
      name: "Signal",
      parameters: [makeParam("SIGNAL_PHONE_NUMBER")],
    });

    render(<ConnectorPluginGroups {...makeGroupProps(plugin)} />);

    // The plugin's own config form must stay mounted…
    expect(configField("signal", "SIGNAL_PHONE_NUMBER")).not.toBeNull();
    // …alongside the companion setup panel, which is delegated to a
    // different plugin id than the card's own.
    const panel = screen.getByTestId("connector-setup-panel");
    expect(panel.getAttribute("data-plugin-id")).toBe(
      "connector-account-management:signal:signal",
    );
  });

  it("keeps the discord config form mounted when switching to the local mode, whose setup panel is delegated to discordlocal", () => {
    const plugin = makePlugin({
      id: "discord",
      name: "Discord",
      parameters: [makeParam("DISCORD_API_TOKEN")],
    });

    render(<ConnectorPluginGroups {...makeGroupProps(plugin)} />);

    // Baseline (default "bot" mode): config form only, no setup panel.
    expect(configField("discord", "DISCORD_API_TOKEN")).not.toBeNull();
    expect(screen.queryByTestId("connector-setup-panel")).toBeNull();

    fireEvent.click(screen.getByTestId("connector-mode-discord-local"));

    // Delegated mode: config form AND the discordlocal panel co-render.
    expect(configField("discord", "DISCORD_API_TOKEN")).not.toBeNull();
    const panel = screen.getByTestId("connector-setup-panel");
    expect(panel.getAttribute("data-plugin-id")).toBe("discordlocal");
  });

  it("still hides the config form in managed Discord mode", () => {
    stateMock.value.elizaCloudConnected = true;
    const plugin = makePlugin({
      id: "discord",
      name: "Discord",
      parameters: [makeParam("DISCORD_API_TOKEN")],
    });

    render(<ConnectorPluginGroups {...makeGroupProps(plugin)} />);
    fireEvent.click(screen.getByTestId("connector-mode-discord-managed"));

    expect(configField("discord", "DISCORD_API_TOKEN")).toBeNull();
  });

  it("still hides the config form in cloud OAuth mode (slack)", () => {
    stateMock.value.elizaCloudConnected = true;
    const plugin = makePlugin({
      id: "slack",
      name: "Slack",
      parameters: [makeParam("SLACK_BOT_TOKEN")],
    });

    render(<ConnectorPluginGroups {...makeGroupProps(plugin)} />);

    // Default plugin-managed mode: config + delegated account panel co-render.
    expect(configField("slack", "SLACK_BOT_TOKEN")).not.toBeNull();
    expect(
      screen
        .getByTestId("connector-setup-panel")
        .getAttribute("data-plugin-id"),
    ).toBe("connector-account-management:slack:slack");

    fireEvent.click(screen.getByTestId("connector-mode-slack-oauth"));

    expect(configField("slack", "SLACK_BOT_TOKEN")).toBeNull();
  });
});
