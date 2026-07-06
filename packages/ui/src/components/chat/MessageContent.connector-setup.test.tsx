// @vitest-environment jsdom

/**
 * Connector-setup widget behavior for the `[CONFIG:<pluginId>]` chat card
 * (#14412): the standardized ChatWidgetShell integration on top of
 * InlinePluginConfig. Covers the minimal-vs-advanced field split (required
 * params render immediately; optional params sit behind ConfigRenderer's
 * Advanced disclosure), the disclosure toggle, collapse-on-connect (a card
 * mounts collapsed for an already-connected plugin and auto-collapses when the
 * enable flow reaches connected status), chevron re-expansion, and field-edit
 * preservation across a collapse/expand round-trip. Runs against the real
 * ConfigRenderer + a mocked ElizaClient, mirroring
 * MessageContent.config.test.tsx.
 */

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
import type { PluginInfo } from "../../api/client-types-config";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

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

/** A Telegram-shaped connector: one required token + optional extras. */
function telegram(over: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "telegram",
    name: "Telegram",
    description: "",
    enabled: false,
    configured: false,
    envKey: null,
    category: "connector",
    source: "bundled",
    parameters: [
      param({
        key: "TELEGRAM_BOT_TOKEN",
        description: "Bot token",
        required: true,
      }),
      param({ key: "TELEGRAM_API_ROOT", description: "API root override" }),
      param({ key: "TELEGRAM_ALLOWED_CHATS", description: "Chat filter" }),
    ],
    validationErrors: [],
    validationWarnings: [],
    ...over,
  };
}

function assistant(text: string): ConversationMessage {
  return {
    id: "m-connector",
    role: "assistant",
    text,
    timestamp: 1_700_000_000_000,
  } as ConversationMessage;
}

function withApp(node: React.ReactElement) {
  const t = (key: string, vars?: Record<string, unknown>) => {
    const template = String(vars?.defaultValue ?? key);
    return template.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
      vars && name in vars ? String(vars[name]) : whole,
    );
  };
  const appValue = {
    t,
    setActionNotice: vi.fn(),
    loadPlugins: vi.fn(() => Promise.resolve()),
    sendActionMessage: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  return render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
}

function widgetBody() {
  return screen.getByTestId("inline-plugin-config-body");
}

function chevron() {
  return screen.getByTestId("inline-plugin-config-chevron");
}

function tokenInput(container: HTMLElement) {
  return container.querySelector(
    'input[data-config-key="TELEGRAM_BOT_TOKEN"]',
  ) as HTMLInputElement | null;
}

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

// ── minimal vs advanced ─────────────────────────────────────────────

describe("connector-setup card — minimal + Advanced split", () => {
  it("renders required params immediately and moves optional params behind Advanced", async () => {
    clientMock.getPlugins.mockResolvedValue({ plugins: [telegram()] });
    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:telegram]")} />,
    );

    await screen.findByText("Telegram Configuration");
    // Minimal set: the schema-required token field is present.
    expect(tokenInput(container)).toBeTruthy();
    // Optional params are NOT rendered until the Advanced disclosure opens.
    expect(
      container.querySelector('input[data-config-key="TELEGRAM_API_ROOT"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        'input[data-config-key="TELEGRAM_ALLOWED_CHATS"]',
      ),
    ).toBeNull();
    // The disclosure advertises how many fields it holds.
    const advancedToggle = screen.getByRole("button", { name: /Advanced/ });
    expect(advancedToggle.textContent).toContain("2");
  });

  it("the Advanced toggle reveals the optional fields", async () => {
    clientMock.getPlugins.mockResolvedValue({ plugins: [telegram()] });
    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:telegram]")} />,
    );
    await screen.findByText("Telegram Configuration");

    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));

    expect(
      container.querySelector('input[data-config-key="TELEGRAM_API_ROOT"]'),
    ).toBeTruthy();
    expect(
      container.querySelector(
        'input[data-config-key="TELEGRAM_ALLOWED_CHATS"]',
      ),
    ).toBeTruthy();
    // Required field stays in place.
    expect(tokenInput(container)).toBeTruthy();
  });

  it("keeps every field minimal when the plugin declares no required params", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [
        telegram({
          parameters: [
            param({ key: "TELEGRAM_API_ROOT", description: "API root" }),
          ],
        }),
      ],
    });
    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:telegram]")} />,
    );
    await screen.findByText("Telegram Configuration");

    // No required params → no promotion; an all-Advanced card would be empty.
    expect(
      container.querySelector('input[data-config-key="TELEGRAM_API_ROOT"]'),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Advanced/ })).toBeNull();
  });
});

// ── collapse-on-connect ─────────────────────────────────────────────

describe("connector-setup card — collapse-on-connect", () => {
  it("mounts collapsed to a compact status row when already connected", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [telegram({ enabled: true, configured: true })],
    });
    withApp(<MessageContent message={assistant("[CONFIG:telegram]")} />);

    await screen.findByText("Telegram Configuration");
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    // Compact summary row + hidden (but mounted) body.
    expect(
      screen.getByTestId("inline-plugin-config-summary").textContent,
    ).toContain("Telegram is enabled.");
    expect(widgetBody().style.display).toBe("none");
    expect(widgetBody().style.contentVisibility).toBe("hidden");
  });

  it("the chevron re-expands a connected card to the full form", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [telegram({ enabled: true, configured: true })],
    });
    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:telegram]")} />,
    );
    await screen.findByText("Telegram Configuration");

    fireEvent.click(chevron());

    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    expect(widgetBody().style.display).toBe("");
    expect(tokenInput(container)).toBeTruthy();
    // The connected card remains fully operable — Disable is reachable.
    expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
  });

  it("auto-collapses when the enable flow reaches connected status", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [telegram({ parameters: [] })],
    });
    clientMock.updatePlugin.mockResolvedValue({ ok: true });
    withApp(<MessageContent message={assistant("[CONFIG:telegram]")} />);

    const enableButton = await screen.findByRole("button", {
      name: "Enable plugin",
    });
    // Unconfigured connector starts expanded.
    expect(chevron().getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(enableButton);

    // Connected status collapses the card to the compact summary.
    await waitFor(() => {
      expect(chevron().getAttribute("aria-expanded")).toBe("false");
    });
    expect(
      screen.getByTestId("inline-plugin-config-summary").textContent,
    ).toContain("Telegram is enabled.");
    expect(widgetBody().style.display).toBe("none");
  });

  it("preserves in-progress field edits across a collapse/expand round-trip", async () => {
    clientMock.getPlugins.mockResolvedValue({ plugins: [telegram()] });
    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:telegram]")} />,
    );
    await screen.findByText("Telegram Configuration");

    fireEvent.change(tokenInput(container) as HTMLInputElement, {
      target: { value: "12345:draft-token" },
    });
    fireEvent.click(chevron()); // manual collapse mid-setup
    expect(widgetBody().style.display).toBe("none");
    fireEvent.click(chevron()); // re-expand

    // The body never unmounted, so the draft survived.
    expect((tokenInput(container) as HTMLInputElement).value).toBe(
      "12345:draft-token",
    );
  });
});
