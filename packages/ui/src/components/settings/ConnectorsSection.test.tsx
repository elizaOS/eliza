// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "../../api";

const appMock = vi.hoisted(() => ({
  value: {} as {
    handlePluginToggle: ReturnType<typeof vi.fn>;
    plugins: PluginInfo[];
    t: (key: string, options?: { defaultValue?: string }) => string;
  },
}));

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
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
      plugins: [],
      t: (_key, options) => options?.defaultValue ?? _key,
    };
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
});
