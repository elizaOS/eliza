// @vitest-environment jsdom

/**
 * Behavioral coverage for Settings → Connectors enable/disable toggling.
 *
 * The sibling ConnectorsSection.test.tsx covers icon fallback and
 * ConnectorsSection.routing.test.ts locks the config-form vs setup-panel mode
 * routing. NEITHER exercises the enable switch. This file drives the switch and
 * asserts the exact call to the mocked `handlePluginToggle` transport boundary,
 * rapid-fire idempotency (in-flight toggles are gated), that always-on / hidden
 * connectors are not toggleable, and that a failed toggle never leaves the row
 * falsely showing "enabled" (the switch is controlled, never optimistic).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    t: (
      key: string,
      options?: { defaultValue?: string; [k: string]: unknown },
    ) => string;
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

/** Interpolates {{name}}-style placeholders so switch aria-labels are unique. */
function interpolate(
  key: string,
  options?: { defaultValue?: string; [k: string]: unknown },
): string {
  let out = options?.defaultValue ?? key;
  if (options) {
    for (const [k, v] of Object.entries(options)) {
      if (k === "defaultValue") continue;
      out = out.replace(new RegExp(`{{${k}}}`, "g"), String(v));
    }
  }
  return out;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("ConnectorsSection enable toggle", () => {
  beforeEach(() => {
    appMock.value = {
      handlePluginToggle: vi.fn(async () => {}),
      handlePluginConfigSave: vi.fn(async () => {}),
      plugins: [],
      elizaCloudConnected: false,
      pluginSaving: new Set<string>(),
      pluginSaveSuccess: new Set<string>(),
      t: interpolate,
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("toggling an enabled connector OFF calls handlePluginToggle(id, false)", () => {
    appMock.value.plugins = [
      plugin({ id: "slack", name: "Slack", enabled: true }),
    ];
    render(<ConnectorsSection />);

    const sw = screen.getByRole("switch", { name: "Disable Slack" });
    expect(sw.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(sw);

    expect(appMock.value.handlePluginToggle).toHaveBeenCalledTimes(1);
    expect(appMock.value.handlePluginToggle).toHaveBeenCalledWith(
      "slack",
      false,
    );
  });

  it("toggling a disabled connector ON calls handlePluginToggle(id, true)", () => {
    appMock.value.plugins = [
      plugin({ id: "discord", name: "Discord", enabled: false }),
    ];
    render(<ConnectorsSection />);

    const sw = screen.getByRole("switch", { name: "Enable Discord" });
    expect(sw.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(sw);

    expect(appMock.value.handlePluginToggle).toHaveBeenCalledTimes(1);
    expect(appMock.value.handlePluginToggle).toHaveBeenCalledWith(
      "discord",
      true,
    );
  });

  it("routes each toggle to its own connector id (no cross-wiring)", () => {
    appMock.value.plugins = [
      plugin({ id: "slack", name: "Slack", enabled: true }),
      plugin({ id: "discord", name: "Discord", enabled: false }),
    ];
    render(<ConnectorsSection />);

    fireEvent.click(screen.getByRole("switch", { name: "Enable Discord" }));
    expect(appMock.value.handlePluginToggle).toHaveBeenLastCalledWith(
      "discord",
      true,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Disable Slack" }));
    expect(appMock.value.handlePluginToggle).toHaveBeenLastCalledWith(
      "slack",
      false,
    );
    expect(appMock.value.handlePluginToggle).toHaveBeenCalledTimes(2);
  });

  it("gates an in-flight toggle: rapid on/off/on fires exactly one call and disables the switch until it settles", async () => {
    const pending = deferred<void>();
    appMock.value.handlePluginToggle = vi.fn(() => pending.promise);
    appMock.value.plugins = [
      plugin({ id: "slack", name: "Slack", enabled: true }),
    ];
    render(<ConnectorsSection />);

    const sw = screen.getByRole("switch", { name: "Disable Slack" });
    fireEvent.click(sw);

    // First click dispatched the toggle and the row is now busy → disabled.
    expect(appMock.value.handlePluginToggle).toHaveBeenCalledTimes(1);
    expect(sw.hasAttribute("disabled")).toBe(true);

    // Hammering the switch while the request is in flight must not queue
    // duplicate/stale writes.
    fireEvent.click(sw);
    fireEvent.click(sw);
    fireEvent.click(sw);
    expect(appMock.value.handlePluginToggle).toHaveBeenCalledTimes(1);

    // Settling the request re-enables the control for the next real toggle.
    pending.resolve();
    await flush();
    expect(sw.hasAttribute("disabled")).toBe(false);

    fireEvent.click(sw);
    expect(appMock.value.handlePluginToggle).toHaveBeenCalledTimes(2);
  });

  it("does not render (or allow toggling) always-on, hidden, or non-connector plugins", () => {
    appMock.value.plugins = [
      plugin({ id: "slack", name: "Slack" }),
      // always-on core plugin — must never be user-toggleable
      plugin({ id: "sql", name: "SQL Core" }),
      // explicitly hidden connector
      plugin({ id: "secret", name: "Hidden Connector", visible: false }),
      // not a connector at all
      plugin({ id: "openai", name: "OpenAI Model", category: "model" }),
    ];
    render(<ConnectorsSection />);

    expect(screen.getByText("Slack")).toBeTruthy();
    expect(screen.queryByText("SQL Core")).toBeNull();
    expect(screen.queryByText("Hidden Connector")).toBeNull();
    expect(screen.queryByText("OpenAI Model")).toBeNull();

    // Exactly one togglable connector switch exists.
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });

  it("renders the empty state when there are no togglable connectors", () => {
    appMock.value.plugins = [plugin({ id: "sql", name: "SQL Core" })];
    render(<ConnectorsSection />);

    expect(screen.getByText("No connectors available.")).toBeTruthy();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("a failed toggle recovers the switch and never falsely shows the connector enabled", async () => {
    // The store contract handles errors internally, but the component must not
    // optimistically flip the switch: it is bound to plugin.enabled, so a
    // rejected/failed toggle leaves the displayed state truthful (still off).
    const captured: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      captured.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    const onNodeUnhandled = (reason: unknown) => captured.push(reason);
    process.on("unhandledRejection", onNodeUnhandled);

    try {
      appMock.value.handlePluginToggle = vi.fn(async () => {
        throw new Error("network down");
      });
      appMock.value.plugins = [
        plugin({ id: "discord", name: "Discord", enabled: false }),
      ];
      render(<ConnectorsSection />);

      const sw = screen.getByRole("switch", { name: "Enable Discord" });
      fireEvent.click(sw);

      expect(appMock.value.handlePluginToggle).toHaveBeenCalledWith(
        "discord",
        true,
      );

      await flush();

      // Store never confirmed the enable → switch still reads OFF (not
      // optimistically checked) and the busy lock has released for a retry.
      expect(sw.getAttribute("aria-checked")).toBe("false");
      expect(sw.hasAttribute("disabled")).toBe(false);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
      process.off("unhandledRejection", onNodeUnhandled);
    }
  });
});
