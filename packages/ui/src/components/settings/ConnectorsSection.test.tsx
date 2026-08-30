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
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "../../api";

const appMock = vi.hoisted(() => ({
  value: {} as {
    handlePluginToggle: ReturnType<typeof vi.fn>;
    handlePluginConfigSave: ReturnType<typeof vi.fn>;
    isLoadingPlugins: boolean;
    loadPlugins: ReturnType<typeof vi.fn>;
    plugins: PluginInfo[];
    pluginsLoaded: boolean;
    pluginsLoadError: string | null;
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

vi.mock("../connectors/DiscordLocalConnectorPanel", () => ({
  DiscordLocalConnectorPanel: () => <div />,
}));
vi.mock("../connectors/IMessageStatusPanel", () => ({
  IMessageStatusPanel: () => <div />,
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
  PluginConfigForm: ({
    plugin,
    onParamChange,
  }: {
    plugin: PluginInfo;
    onParamChange: (pluginId: string, key: string, value: string) => void;
  }) => (
    <div data-testid="plugin-config-form">
      <button
        type="button"
        onClick={() => onParamChange(plugin.id, "TOKEN", "token-value")}
      >
        Stage token
      </button>
      <button
        type="button"
        onClick={() => onParamChange(plugin.id, "TOKEN", "newer-token")}
      >
        Stage newer token
      </button>
      <button
        type="button"
        onClick={() => onParamChange(plugin.id, "APP_ID", "app-value")}
      >
        Stage app ID
      </button>
    </div>
  ),
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
      isLoadingPlugins: false,
      loadPlugins: vi.fn(async () => {}),
      plugins: [],
      pluginsLoaded: true,
      pluginsLoadError: null,
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
    vi.useRealTimers();
  });

  it("renders a connector-shaped loading state before the runtime catalog resolves", () => {
    appMock.value.pluginsLoaded = false;
    appMock.value.isLoadingPlugins = true;

    render(<ConnectorsSection />);

    expect(screen.getByTestId("connectors-loading")).toBeTruthy();
    expect(screen.queryByTestId("connectors-empty")).toBeNull();
  });

  it("surfaces a failed runtime catalog with a working retry", () => {
    appMock.value.pluginsLoaded = false;
    appMock.value.pluginsLoadError = "Runtime catalog is unavailable";

    render(<ConnectorsSection />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Runtime catalog is unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(appMock.value.loadPlugins).toHaveBeenCalledOnce();
  });

  it("retries once after the app-core plugin registry cold-load window", async () => {
    vi.useFakeTimers();
    appMock.value.pluginsLoaded = false;
    appMock.value.pluginsLoadError = "Plugin registry is still loading";

    render(<ConnectorsSection />);
    expect(appMock.value.loadPlugins).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(appMock.value.loadPlugins).toHaveBeenCalledOnce();
  });

  it("labels a resolved empty runtime separately from loading and failure", () => {
    render(<ConnectorsSection />);

    expect(screen.getByTestId("connectors-empty")).toBeTruthy();
    expect(screen.getByText("No connectors reported")).toBeTruthy();
    expect(screen.queryByTestId("connectors-loading")).toBeNull();
  });

  it("keeps managed providers reachable from the canonical Connectors surface", () => {
    render(<ConnectorsSection />);

    fireEvent.click(screen.getByTestId("managed-cloud-connections"));

    expect(window.location.hash).toBe("#cloud-connectors");
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

  it("commits multi-field drafts once and blocks duplicate saves", async () => {
    let resolveSave: ((saved: boolean) => void) | undefined;
    appMock.value.handlePluginConfigSave = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSave = resolve;
        }),
    );
    appMock.value.plugins = [
      plugin({
        id: "discord",
        name: "Discord",
        parameters: [tokenParam("DISCORD_API_TOKEN")],
      }),
    ];

    render(<ConnectorsSection />);
    openDetail("Discord");
    fireEvent.click(screen.getByRole("button", { name: "Stage token" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage app ID" }));

    const save = screen.getByRole("button", { name: "Save changes" });
    fireEvent.click(save);
    fireEvent.click(save);

    expect(appMock.value.handlePluginConfigSave).toHaveBeenCalledOnce();
    expect(appMock.value.handlePluginConfigSave).toHaveBeenCalledWith(
      "discord",
      { TOKEN: "token-value", APP_ID: "app-value" },
    );
    resolveSave?.(true);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull(),
    );
  });

  it("preserves a newer same-field edit when an older save completes", async () => {
    let resolveFirst: ((saved: boolean) => void) | undefined;
    appMock.value.handlePluginConfigSave = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(true);
    appMock.value.plugins = [
      plugin({
        id: "discord",
        name: "Discord",
        parameters: [tokenParam("DISCORD_API_TOKEN")],
      }),
    ];

    render(<ConnectorsSection />);
    openDetail("Discord");
    fireEvent.click(screen.getByRole("button", { name: "Stage token" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage newer token" }));
    resolveFirst?.(true);

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Save changes" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(appMock.value.handlePluginConfigSave).toHaveBeenCalledTimes(2),
    );
    expect(appMock.value.handlePluginConfigSave).toHaveBeenLastCalledWith(
      "discord",
      { TOKEN: "newer-token" },
    );
  });

  it("retains staged drafts after a failed save and lets Cancel discard them", async () => {
    appMock.value.handlePluginConfigSave = vi.fn(async () => false);
    appMock.value.plugins = [
      plugin({
        id: "discord",
        name: "Discord",
        parameters: [tokenParam("DISCORD_API_TOKEN")],
      }),
    ];

    render(<ConnectorsSection />);
    openDetail("Discord");
    fireEvent.click(screen.getByRole("button", { name: "Stage token" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("hides bot-only connectors under the delegate lens and restores them via the footnote switch", () => {
    appMock.value.plugins = [
      plugin({ id: "slack", name: "Slack" }),
      plugin({ id: "matrix", name: "Matrix" }),
    ];

    render(<ConnectorsSection />);
    fireEvent.click(screen.getByTestId("connector-channel-mode-delegate"));

    // Slack remains available through its OWNER-role plugin-managed inventory;
    // its app-token modes themselves are still Bot-only.
    expect(screen.getByText("Slack")).toBeTruthy();
    expect(screen.queryByText("Matrix")).toBeNull();
    const footnoteSwitch = screen.getByRole("button", {
      name: /Switch to/,
    });

    fireEvent.click(footnoteSwitch);

    expect(screen.getByText("Slack")).toBeTruthy();
    expect(screen.getByText("Matrix")).toBeTruthy();
    expect(
      screen
        .getByTestId("connector-channel-mode-bot")
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: /Switch to/ })).toBeNull();
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

  it("toggles a connector from the detail SettingsSwitchRow", async () => {
    appMock.value.plugins = [plugin({ id: "telegram", name: "Telegram" })];
    render(<ConnectorsSection />);
    openDetail("Telegram");
    const enable = document.getElementById("connector-telegram-enable");
    expect(enable).toBeTruthy();
    expect(enable?.getAttribute("role")).toBe("switch");
    expect(enable?.getAttribute("data-agent-id")).toBe(
      "connector-telegram-enable",
    );
    fireEvent.click(enable as HTMLElement);
    await waitFor(() =>
      expect(appMock.value.handlePluginToggle).toHaveBeenCalledWith(
        "telegram",
        false,
      ),
    );
  });

  it("returns to the index from detail back control", async () => {
    appMock.value.plugins = [plugin({ id: "telegram", name: "Telegram" })];
    render(<ConnectorsSection />);
    openDetail("Telegram");
    expect(screen.getByTestId("connector-detail")).toBeTruthy();
    const back = screen.getByTestId("connector-detail-back");
    // Mobile uses ViewHeader; this control is desktop-only with a 44px target.
    expect(back.className).toMatch(/\bhidden\b/);
    expect(back.className).toMatch(/\bmd:inline-flex\b/);
    expect(back.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(back);
    await waitFor(() =>
      expect(screen.getByTestId("connectors-index")).toBeTruthy(),
    );
  });

  it("rejects a fallback-classified connector deep link under the wrong lens", async () => {
    // Google is Delegate-only; a Bot-lens deep link must not open its detail.
    appMock.value.plugins = [plugin({ id: "google", name: "Google" })];
    act(() => setConnectorChannelMode("bot"));
    window.history.replaceState(null, "", "/#connectors/google");
    window.dispatchEvent(new Event("popstate"));

    render(<ConnectorsSection />);
    await waitFor(() =>
      expect(screen.getByTestId("connector-not-found")).toBeTruthy(),
    );
    expect(screen.queryByTestId("connector-detail")).toBeNull();

    act(() => setConnectorChannelMode("delegate"));
    await waitFor(() =>
      expect(screen.getByTestId("connector-detail")).toBeTruthy(),
    );
  });
});
