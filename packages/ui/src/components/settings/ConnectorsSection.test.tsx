// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo, PluginParamDef } from "../../api";

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
vi.mock("../connectors/TelegramBotSetupPanel", () => ({
  TelegramBotSetupPanel: () => <div data-testid="telegram-bot-setup-panel" />,
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
  });

  afterEach(() => {
    cleanup();
  });

  function botTokenParam(): PluginParamDef {
    return {
      key: "TELEGRAM_BOT_TOKEN",
      type: "string",
      description: "BotFather token",
      required: true,
      sensitive: true,
      currentValue: null,
      isSet: false,
    };
  }

  // Regression test for #10281: in Telegram bot-token mode the Settings →
  // Connectors surface must render the env-config form AND the live
  // TelegramBotSetupPanel together. It previously rendered them either/or and
  // silently dropped the panel.
  it("co-renders the Telegram bot-token form AND its setup panel (#10281)", () => {
    appMock.value.plugins = [
      plugin({
        id: "telegram",
        name: "Telegram",
        parameters: [botTokenParam()],
      }),
    ];

    render(<ConnectorsSection />);

    // Telegram defaults to the plugin-managed mode; select Bot Token explicitly
    // (the mode where both the form and the panel apply).
    fireEvent.click(screen.getByTestId("connector-mode-telegram-bot"));

    // The env form (its save control) AND the companion panel both present.
    expect(screen.getByText("Save settings")).toBeTruthy();
    expect(screen.getByTestId("telegram-bot-setup-panel")).toBeTruthy();
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
});
