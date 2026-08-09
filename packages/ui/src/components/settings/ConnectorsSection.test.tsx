/** Verifies ConnectorsSection through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Renders ConnectorsSection with a mocked App context and connector-mode
 * registry to assert index/detail routing, icon fallbacks, and setup-panel
 * co-render on the detail page. jsdom, no backend.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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

const connectorModeMock = vi.hoisted(() => ({
  byId: {} as Record<
    string,
    {
      setupPluginId: string | null;
      selectedMode: string;
      modes: Array<{ id: string; managementMode: string | undefined }>;
      setSelectedMode?: (id: string) => void;
    }
  >,
}));
vi.mock("../connectors/ConnectorModeSelector.hooks", () => ({
  useConnectorMode: (pluginId: string) =>
    connectorModeMock.byId[pluginId] ?? {
      setupPluginId: pluginId,
      selectedMode: "default",
      modes: [{ id: "default", managementMode: undefined }],
      setSelectedMode: () => {},
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
vi.mock("../connectors/ConnectorSetupPanel.helpers", () => ({
  hasConnectorSetupPanel: (id: string) =>
    id === "telegram" || id === "whatsapp",
}));
vi.mock("../pages/PluginConfigForm", () => ({
  PluginConfigForm: () => <div data-testid="plugin-config-form" />,
}));

import { setConnectorChannelMode } from "../connectors/connector-channel-mode";
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

function openDetail(name: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(name, "i") }));
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
    setConnectorChannelMode("delegate");
    window.history.replaceState(null, "", "/");
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

  it("opens a detail page from the index and co-renders setup + config for telegram bot mode", () => {
    connectorModeMock.byId.telegram = {
      setupPluginId: "telegram",
      selectedMode: "bot",
      modes: [{ id: "bot", managementMode: "local-config" }],
      setSelectedMode: () => {},
    };
    appMock.value.plugins = [
      plugin({
        id: "telegram",
        name: "Telegram",
        parameters: [tokenParam("TELEGRAM_BOT_TOKEN")],
      }),
    ];

    render(<ConnectorsSection />);
    expect(screen.getByTestId("connectors-index")).toBeTruthy();
    openDetail("Telegram");

    expect(screen.getByTestId("connector-detail")).toBeTruthy();
    expect(screen.getByTestId("plugin-config-form")).toBeTruthy();
    const panel = screen.getByTestId("connector-setup-panel");
    expect(panel.textContent ?? "").toContain("telegram");
  });

  it("co-renders the setup panel for whatsapp business mode on detail", () => {
    connectorModeMock.byId.whatsapp = {
      setupPluginId: "whatsapp",
      selectedMode: "business",
      modes: [{ id: "business", managementMode: "local-config" }],
      setSelectedMode: () => {},
    };
    appMock.value.plugins = [
      plugin({
        id: "whatsapp",
        name: "WhatsApp",
        parameters: [tokenParam("WHATSAPP_ACCESS_TOKEN")],
      }),
    ];

    render(<ConnectorsSection />);
    openDetail("WhatsApp");

    expect(screen.getByTestId("plugin-config-form")).toBeTruthy();
    expect(
      (screen.getByTestId("connector-setup-panel").textContent ?? "").includes(
        "whatsapp",
      ),
    ).toBe(true);
  });

  it("renders config form without setup panel for discord bot local-config", () => {
    connectorModeMock.byId.discord = {
      setupPluginId: "discord",
      selectedMode: "bot",
      modes: [{ id: "bot", managementMode: "local-config" }],
      setSelectedMode: () => {},
    };
    appMock.value.plugins = [
      plugin({
        id: "discord",
        name: "Discord",
        parameters: [tokenParam("DISCORD_API_TOKEN")],
      }),
    ];

    render(<ConnectorsSection />);
    openDetail("Discord");

    expect(screen.getByTestId("plugin-config-form")).toBeTruthy();
    expect(screen.queryByTestId("connector-setup-panel")).toBeNull();
  });

  it("hides bot-only connectors under the delegate lens and restores them via the footnote switch", () => {
    appMock.value.plugins = [
      plugin({ id: "slack", name: "Slack" }),
      plugin({ id: "signal", name: "Signal" }),
    ];

    render(<ConnectorsSection />);

    expect(screen.getByText("Signal")).toBeTruthy();
    expect(screen.queryByText("Slack")).toBeNull();
    const footnoteSwitch = screen.getByRole("button", {
      name: /Switch to/,
    });

    fireEvent.click(footnoteSwitch);

    expect(screen.getByText("Slack")).toBeTruthy();
    expect(screen.queryByText("Signal")).toBeNull();
    expect(screen.getByRole("button", { name: /Switch to/ })).toBeTruthy();
  });

  it("keeps unclassified connectors visible under both lenses", () => {
    appMock.value.plugins = [
      plugin({ id: "acmechat-unknown", name: "Acme Chat" }),
    ];

    render(<ConnectorsSection />);
    expect(screen.getByText("Acme Chat")).toBeTruthy();

    act(() => setConnectorChannelMode("bot"));
    expect(screen.getByText("Acme Chat")).toBeTruthy();
  });

  it("returns to the index from detail back control", () => {
    appMock.value.plugins = [plugin({ id: "signal", name: "Signal" })];
    render(<ConnectorsSection />);
    openDetail("Signal");
    expect(screen.getByTestId("connector-detail")).toBeTruthy();
    fireEvent.click(screen.getByTestId("connector-detail-back"));
    expect(screen.getByTestId("connectors-index")).toBeTruthy();
  });
});
