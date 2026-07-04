// @vitest-environment jsdom
/**
 * Renders ConnectorsSection with a mocked App context and connector-mode
 * registry to assert icon fallbacks (no raw emoji glyphs) and the setup-panel
 * routing. jsdom, no backend.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "../../api";

const appMock = vi.hoisted(() => ({
  value: {} as {
    handlePluginToggle: ReturnType<typeof vi.fn>;
    handlePluginConfigSave: ReturnType<typeof vi.fn>;
    plugins: PluginInfo[];
    elizaCloudConnected: boolean;
    pluginSaving: Set<string>;
    pluginSaveSuccess: Set<string>;
    t: (key: string, options?: { defaultValue?: string }) => string;
  },
}));

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
  useAppSelector: (sel: (value: typeof appMock.value) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: typeof appMock.value) => unknown) =>
    sel(appMock.value),
}));

vi.mock("../connectors/BlueBubblesStatusPanel", () => ({
  BlueBubblesStatusPanel: () => <div />,
}));
vi.mock("../connectors/DiscordLocalConnectorPanel", () => ({
  DiscordLocalConnectorPanel: () => <div />,
}));
vi.mock("../connectors/IMessageStatusPanel", () => ({
  IMessageStatusPanel: () => <div />,
}));
vi.mock("../connectors/SignalQrOverlay", () => ({
  SignalQrOverlay: () => <div />,
}));
vi.mock("../connectors/TelegramAccountConnectorPanel", () => ({
  TelegramAccountConnectorPanel: () => <div />,
}));
vi.mock("../connectors/WhatsAppQrOverlay", () => ({
  WhatsAppQrOverlay: () => <div />,
}));

// Controllable connector-mode per plugin id. Defaults to a benign mode so the
// pre-existing icon test is unaffected; tests opt into telegram/discord modes.
const connectorModeMock = vi.hoisted(() => ({
  byId: {} as Record<
    string,
    {
      setupPluginId: string | null;
      selectedMode: string;
      modes: Array<{ id: string; managementMode: string | undefined }>;
    }
  >,
}));
vi.mock("../connectors/ConnectorModeSelector.hooks", () => ({
  useConnectorMode: (pluginId: string) =>
    connectorModeMock.byId[pluginId] ?? {
      setupPluginId: pluginId,
      selectedMode: "default",
      modes: [{ id: "default", managementMode: undefined }],
    },
}));
vi.mock("../connectors/ConnectorModeSelector", () => ({
  ConnectorModeSelector: () => <div data-testid="mode-selector" />,
}));
vi.mock("../connectors/ConnectorSetupPanel", () => ({
  ConnectorSetupPanel: ({ pluginId }: { pluginId: string }) => (
    <div data-testid="connector-setup-panel">setup:{pluginId}</div>
  ),
}));
vi.mock("../pages/PluginConfigForm", () => ({
  PluginConfigForm: () => <div data-testid="plugin-config-form" />,
}));

import { ConnectorsSection } from "./ConnectorsSection";

function plugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    category: "connector",
    configured: true,
    description: "",
    enabled: true,
    envKey: null,
    id: "custom-connector",
    name: "Custom Connector",
    parameters: [],
    source: "bundled",
    validationErrors: [],
    validationWarnings: [],
    visible: true,
    ...overrides,
  } as PluginInfo;
}

describe("ConnectorsSection", () => {
  beforeEach(() => {
    appMock.value = {
      handlePluginToggle: vi.fn(async () => {}),
      handlePluginConfigSave: vi.fn(async () => {}),
      plugins: [],
      elizaCloudConnected: false,
      pluginSaving: new Set<string>(),
      pluginSaveSuccess: new Set<string>(),
      t: (_key, options) => options?.defaultValue ?? _key,
    };
    connectorModeMock.byId = {};
  });

  afterEach(() => {
    cleanup();
  });

  it("falls back to icon components instead of raw emoji icon metadata", () => {
    const rawConnectorGlyph = "\u{1F50C}";
    const rawPuzzleGlyph = "\u{1F9E9}";
    appMock.value.plugins = [
      plugin({ icon: rawConnectorGlyph } as Partial<PluginInfo>),
    ];

    const { container } = render(<ConnectorsSection />);

    expect(screen.getByText("Custom Connector")).toBeTruthy();
    expect(container.textContent ?? "").not.toContain(rawConnectorGlyph);
    expect(container.textContent ?? "").not.toContain(rawPuzzleGlyph);
    expect(container.querySelector("svg")).toBeTruthy();
  });

  function tokenParam(key: string): PluginInfo["parameters"][number] {
    return {
      key,
      type: "string",
      description: "",
      required: true,
      sensitive: true,
      currentValue: null,
      isSet: false,
    };
  }

  // Regression #10281: Settings → Connectors must co-render the live setup
  // panel alongside the env-config form (the canonical /connectors page does).
  // Before the fix, the showPluginConfig branch dropped the panel.
  it("co-renders the live setup panel alongside the config form for telegram bot mode", () => {
    connectorModeMock.byId.telegram = {
      setupPluginId: "telegram",
      selectedMode: "bot",
      modes: [{ id: "bot", managementMode: "local-config" }],
    };
    appMock.value.plugins = [
      plugin({
        id: "telegram",
        name: "Telegram",
        parameters: [tokenParam("TELEGRAM_BOT_TOKEN")],
      }),
    ];

    render(<ConnectorsSection />);

    expect(screen.getByTestId("plugin-config-form")).toBeTruthy();
    const panel = screen.getByTestId("connector-setup-panel");
    expect(panel).toBeTruthy();
    expect(panel.textContent ?? "").toContain("telegram");
  });

  // whatsapp business mode is the third local-config + has-panel case; it must
  // co-render like /connectors does (the panel is the whatsapp pairing surface).
  it("co-renders the setup panel for whatsapp business mode", () => {
    connectorModeMock.byId.whatsapp = {
      setupPluginId: "whatsapp",
      selectedMode: "business",
      modes: [{ id: "business", managementMode: "local-config" }],
    };
    appMock.value.plugins = [
      plugin({
        id: "whatsapp",
        name: "WhatsApp",
        parameters: [tokenParam("WHATSAPP_ACCESS_TOKEN")],
      }),
    ];

    render(<ConnectorsSection />);

    expect(screen.getByTestId("plugin-config-form")).toBeTruthy();
    expect(
      (screen.getByTestId("connector-setup-panel").textContent ?? "").includes(
        "whatsapp",
      ),
    ).toBe(true);
  });

  it("renders no setup panel for a local-config connector that has none (discord)", () => {
    connectorModeMock.byId.discord = {
      setupPluginId: "discord",
      selectedMode: "bot",
      modes: [{ id: "bot", managementMode: "local-config" }],
    };
    appMock.value.plugins = [
      plugin({
        id: "discord",
        name: "Discord",
        parameters: [tokenParam("DISCORD_API_TOKEN")],
      }),
    ];

    render(<ConnectorsSection />);

    expect(screen.getByTestId("plugin-config-form")).toBeTruthy();
    expect(screen.queryByTestId("connector-setup-panel")).toBeNull();
  });
});
