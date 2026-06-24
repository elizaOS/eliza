// @vitest-environment jsdom
//
// Coverage for the `[CONFIG:<pluginId>]` chat marker (#9304): the parser side
// (`CONFIG_RE` / `parseSegments` recognition + prototype-pollution rejection)
// AND the stateful `InlinePluginConfig` renderer that the `config` segment maps
// to in MessageContent. The renderer is a ~300-line self-contained component
// that fetches plugin metadata and drives save / enable / disable mutations
// through the typed `ElizaClient`, so it gets exercised end-to-end (loading →
// not-found / configurable-params → save success / error → enable toggle →
// dismissed) against a mocked client, asserting the real DOM/handler effects
// rather than render-presence alone.

import type { PluginParamDef } from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFrozenClock, withSeededRandom } from "../../../test/determinism";
import type { ConversationMessage } from "../../api/client-types-chat";
import type {
  PluginInfo,
  PluginMutationResult,
} from "../../api/client-types-config";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";
import {
  CONFIG_RE,
  isSafeNormalizedPluginId,
  normalizePluginId,
  parseSegments,
  type Segment,
} from "./message-parser-helpers";

// ── client mock ─────────────────────────────────────────────────────
// InlinePluginConfig is self-contained: it reads `client.getPlugins()` and
// writes via `client.updatePlugin()`. Hoist a single mock object so the
// vi.mock factory and the test body reference the same spies.
const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getPlugins: vi.fn(),
    updatePlugin: vi.fn(),
  },
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

import { MessageContent } from "./MessageContent";

// ── fixtures ────────────────────────────────────────────────────────

function param(
  over: Partial<PluginParamDef> & { key: string },
): PluginParamDef {
  return {
    type: "string",
    description: "",
    required: false,
    sensitive: false,
    currentValue: null,
    isSet: false,
    ...over,
  };
}

function plugin(over: Partial<PluginInfo> & { id: string }): PluginInfo {
  return {
    name: over.id,
    description: "",
    enabled: false,
    configured: false,
    envKey: null,
    category: "feature",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    ...over,
  };
}

function mutationResult(
  over: Partial<PluginMutationResult> = {},
): PluginMutationResult {
  return { ok: true, ...over };
}

function assistant(text: string): ConversationMessage {
  return {
    id: "m-config",
    role: "assistant",
    text,
    timestamp: 1_700_000_000_000,
  } as ConversationMessage;
}

// The component reads `setActionNotice`, `loadPlugins`, and `t` from the app
// selector store. Seed a typed-enough stub; capture the spies so tests can
// assert the toggle wired them.
function withApp(node: React.ReactElement) {
  const setActionNotice = vi.fn();
  const loadPlugins = vi.fn(() => Promise.resolve());
  // Mirror the real `t`: render the defaultValue (or key) and interpolate the
  // `{{var}}` placeholders the component passes, so assertions can target the
  // resolved copy ("Weather Configuration", "Loading weather configuration...").
  const t = (key: string, vars?: Record<string, unknown>) => {
    const template = String(vars?.defaultValue ?? key);
    return template.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
      vars && name in vars ? String(vars[name]) : whole,
    );
  };
  const appValue = {
    t,
    setActionNotice,
    loadPlugins,
    sendActionMessage: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  const utils = render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
  return { ...utils, setActionNotice, loadPlugins };
}

// ── parser side ─────────────────────────────────────────────────────

describe("[CONFIG] marker parsing", () => {
  it("CONFIG_RE matches a bare plugin id and a scoped npm id", () => {
    CONFIG_RE.lastIndex = 0;
    const ids = Array.from(
      "[CONFIG:weather] and [CONFIG:@elizaos/plugin-x]".matchAll(CONFIG_RE),
    ).map((m) => m[1]);
    expect(ids).toEqual(["weather", "@elizaos/plugin-x"]);
  });

  it("parseSegments lifts [CONFIG:weather] into a config segment", () => {
    const segments = parseSegments("Configure it: [CONFIG:weather]", false);
    const config = segments.find(
      (s): s is Extract<Segment, { kind: "config" }> => s.kind === "config",
    );
    expect(config?.pluginId).toBe("weather");
    // The surrounding prose survives as its own text segment.
    expect(
      segments.some(
        (s) => s.kind === "text" && s.text.includes("Configure it"),
      ),
    ).toBe(true);
  });

  it("parseSegments recognizes a scoped npm plugin id", () => {
    const segments = parseSegments("[CONFIG:@elizaos/plugin-x]", false);
    const config = segments.find(
      (s): s is Extract<Segment, { kind: "config" }> => s.kind === "config",
    );
    expect(config?.pluginId).toBe("@elizaos/plugin-x");
    // ...and normalizing the scoped id strips the @scope/plugin- prefix.
    expect(normalizePluginId(config?.pluginId ?? "")).toBe("x");
  });

  it("rejects a prototype-pollution id via isSafeNormalizedPluginId", () => {
    expect(isSafeNormalizedPluginId(normalizePluginId("__proto__"))).toBe(
      false,
    );
    expect(isSafeNormalizedPluginId(normalizePluginId("constructor"))).toBe(
      false,
    );
    expect(isSafeNormalizedPluginId(normalizePluginId("prototype"))).toBe(
      false,
    );
    // A normal id passes.
    expect(
      isSafeNormalizedPluginId(normalizePluginId("@elizaos/plugin-x")),
    ).toBe(true);
  });

  it("does not render an InlinePluginConfig for a prototype-pollution id", () => {
    // The renderer guards on isSafeNormalizedPluginId before mounting, so a
    // poisoned id yields no config UI even though the parser produced a segment.
    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:__proto__]")} />,
    );
    expect(clientMock.getPlugins).not.toHaveBeenCalled();
    // No raw marker leaks into the DOM either.
    expect(container.textContent ?? "").not.toContain("[CONFIG:");
  });
});

// ── renderer side ───────────────────────────────────────────────────

describe("MessageContent → InlinePluginConfig states", () => {
  beforeEach(() => {
    withFrozenClock();
    withSeededRandom();
    clientMock.getPlugins.mockReset();
    clientMock.updatePlugin.mockReset();
  });

  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
  });

  it("shows the loading placeholder while the plugin fetch is pending", () => {
    clientMock.getPlugins.mockReturnValue(new Promise(() => undefined));
    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:weather]")} />,
    );
    expect(container.textContent ?? "").toContain(
      "Loading weather configuration...",
    );
  });

  it("shows the not-found message when the plugin is absent", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [plugin({ id: "other" })],
    });
    withApp(<MessageContent message={assistant("[CONFIG:weather]")} />);
    expect(await screen.findByText('Plugin "weather" not found.')).toBeTruthy();
  });

  it("renders the configurable params and the plugin title for a found plugin", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [
        plugin({
          id: "weather",
          name: "Weather",
          parameters: [
            param({ key: "WEATHER_API_KEY", description: "API key" }),
          ],
        }),
      ],
    });
    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:weather]")} />,
    );
    // Header title.
    expect(await screen.findByText("Weather Configuration")).toBeTruthy();
    // The configurable field renders with the auto-derived label ("API Key")
    // and an input bound to the param key (no "no configurable params" notice).
    expect(screen.getByText("API Key")).toBeTruthy();
    expect(
      container.querySelector('input[data-config-key="WEATHER_API_KEY"]'),
    ).toBeTruthy();
  });

  it("saves edited config via updatePlugin and surfaces the saved state", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [
        plugin({
          id: "weather",
          name: "Weather",
          parameters: [
            param({ key: "WEATHER_API_KEY", description: "API key" }),
          ],
        }),
      ],
    });
    clientMock.updatePlugin.mockResolvedValue(mutationResult());

    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:weather]")} />,
    );
    const input =
      (await screen.findByText("Weather Configuration")) &&
      container.querySelector('input[data-config-key="WEATHER_API_KEY"]');
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, {
      target: { value: "sk-live-123" },
    });

    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => {
      expect(clientMock.updatePlugin).toHaveBeenCalledWith("weather", {
        config: { WEATHER_API_KEY: "sk-live-123" },
      });
    });
    // "Saved" confirmation surfaces after the mutation resolves.
    expect(await screen.findByText("common.saved")).toBeTruthy();
  });

  it("surfaces the server error message when save fails", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [
        plugin({
          id: "weather",
          name: "Weather",
          parameters: [
            param({ key: "WEATHER_API_KEY", description: "API key" }),
          ],
        }),
      ],
    });
    clientMock.updatePlugin.mockRejectedValue(new Error("Invalid API key"));

    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:weather]")} />,
    );
    await screen.findByText("Weather Configuration");
    const input = container.querySelector(
      'input[data-config-key="WEATHER_API_KEY"]',
    );
    fireEvent.change(input as HTMLInputElement, {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    expect(await screen.findByText("Invalid API key")).toBeTruthy();
    // No "Saved" confirmation when the mutation rejected.
    expect(screen.queryByText("common.saved")).toBeNull();
  });

  it("enabling a disabled plugin calls updatePlugin({enabled:true}), refreshes, notifies, and dismisses", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [plugin({ id: "weather", name: "Weather", enabled: false })],
    });
    clientMock.updatePlugin.mockResolvedValue(mutationResult());

    const { setActionNotice, loadPlugins } = withApp(
      <MessageContent message={assistant("[CONFIG:weather]")} />,
    );
    const enableButton = await screen.findByRole("button", {
      name: "Enable plugin",
    });
    fireEvent.click(enableButton);

    await waitFor(() => {
      expect(clientMock.updatePlugin).toHaveBeenCalledWith("weather", {
        enabled: true,
      });
    });
    // Shared plugin state is refreshed and a success notice is queued.
    expect(loadPlugins).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(setActionNotice).toHaveBeenCalledWith(
        expect.stringContaining("Weather is on."),
        "success",
        4000,
      );
    });
    // The widget collapses to the dismissed "enabled" confirmation.
    expect(await screen.findByText("Weather is enabled.")).toBeTruthy();
  });

  it("disabling an enabled plugin calls updatePlugin({enabled:false}) and does not dismiss", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [plugin({ id: "weather", name: "Weather", enabled: true })],
    });
    clientMock.updatePlugin.mockResolvedValue(mutationResult());

    const { setActionNotice } = withApp(
      <MessageContent message={assistant("[CONFIG:weather]")} />,
    );
    const disableButton = await screen.findByRole("button", {
      name: "Disable",
    });
    fireEvent.click(disableButton);

    await waitFor(() => {
      expect(clientMock.updatePlugin).toHaveBeenCalledWith("weather", {
        enabled: false,
      });
    });
    // Disabling does not emit the enable notice nor collapse the widget.
    expect(setActionNotice).not.toHaveBeenCalled();
    expect(screen.queryByText("Weather is enabled.")).toBeNull();
  });
});
