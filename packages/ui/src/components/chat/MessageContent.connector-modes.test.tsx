/** Verifies connector-setup card — renders for each chat-set-up connector through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Auth-mode behavior for the `[CONFIG:<pluginId>]` connector-setup card: the
 * OAuth / API-key / local-bridge mode switch (projected from the shared
 * connector-mode registry), the "Sign in with <provider>" OAuth hand-off, the
 * visible fallback toggle away from OAuth, the one-click Discord desktop
 * pairing, and per-connector render coverage for the five chat-set-up
 * connectors (discord, telegram, signal, imessage, wechat). Runs against the
 * real ConfigRenderer + a mocked ElizaClient — the mode projection itself is
 * the real registry, so a mode the settings page shows is a mode this card
 * shows.
 */

import type { PluginParamDef } from "@elizaos/shared";
import {
  act,
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
import { persistCapabilityConnectorContinuation } from "../../capability-workspace-handoff";
import { CHAT_PREFILL_EVENT } from "../../events";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

const {
  clientMock,
  sendActionMessageMock,
  setActionNoticeMock,
  windowOpenMock,
} = vi.hoisted(() => ({
  clientMock: {
    getPlugins: vi.fn(),
    updatePlugin: vi.fn(),
    startConnectorAccountOAuth: vi.fn(),
    authorizeDiscordLocal: vi.fn(),
  },
  sendActionMessageMock: vi.fn(),
  setActionNoticeMock: vi.fn(),
  windowOpenMock: vi.fn(),
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
    category: "connector",
    source: "bundled",
    parameters: [param({ key: "TOKEN", description: "token", required: true })],
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

function withApp(
  node: React.ReactElement,
  opts: { elizaCloudConnected?: boolean } = {},
) {
  const t = (key: string, vars?: Record<string, unknown>) => {
    const template = String(vars?.defaultValue ?? key);
    return template.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
      vars && name in vars ? String(vars[name]) : whole,
    );
  };
  const appValue = {
    t,
    setActionNotice: setActionNoticeMock,
    loadPlugins: vi.fn(() => Promise.resolve()),
    sendActionMessage: sendActionMessageMock,
    elizaCloudConnected: opts.elizaCloudConnected ?? false,
  } as never;
  __setAppValueForTests(appValue);
  return render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
}

beforeEach(() => {
  withFrozenClock();
  withSeededRandom();
  clientMock.getPlugins.mockReset();
  clientMock.updatePlugin.mockReset();
  clientMock.startConnectorAccountOAuth.mockReset();
  clientMock.authorizeDiscordLocal.mockReset();
  sendActionMessageMock.mockReset();
  setActionNoticeMock.mockReset();
  windowOpenMock.mockReset();
  vi.stubGlobal("open", windowOpenMock);
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __setAppValueForTests(null);
});

// ── per-connector render ────────────────────────────────────────────

describe("connector-setup card — renders for each chat-set-up connector", () => {
  for (const id of ["discord", "telegram", "signal", "imessage", "wechat"]) {
    it(`renders the setup card for ${id}`, async () => {
      clientMock.getPlugins.mockResolvedValue({
        plugins: [plugin({ id })],
      });
      withApp(<MessageContent message={assistant(`[CONFIG:${id}]`)} />);
      await screen.findByText(`${id} Configuration`);
      // The card shell mounted for this connector.
      expect(screen.getByTestId("inline-plugin-config")).toBeTruthy();
    });
  }
});

// ── mode switch ─────────────────────────────────────────────────────

describe("connector-setup card — auth-mode switch", () => {
  it("shows the OAuth + Bot Token + Desktop modes for Discord when cloud is connected", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [plugin({ id: "discord", name: "Discord" })],
    });
    withApp(<MessageContent message={assistant("[CONFIG:discord]")} />, {
      elizaCloudConnected: true,
    });
    await screen.findByText("Discord Configuration");

    // The cloud-managed OAuth gateway mode is offered only with cloud on.
    expect(
      screen.getByTestId("inline-plugin-config-mode-managed"),
    ).toBeTruthy();
    expect(screen.getByTestId("inline-plugin-config-mode-bot")).toBeTruthy();
    expect(screen.getByTestId("inline-plugin-config-mode-local")).toBeTruthy();
  });

  it("drops the cloud-only OAuth mode for Discord when cloud is NOT connected", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [plugin({ id: "discord", name: "Discord" })],
    });
    withApp(<MessageContent message={assistant("[CONFIG:discord]")} />, {
      elizaCloudConnected: false,
    });
    await screen.findByText("Discord Configuration");

    // Offering a sign-in that cannot succeed would be a fabricated affordance.
    expect(
      screen.queryByTestId("inline-plugin-config-mode-managed"),
    ).toBeNull();
    expect(screen.getByTestId("inline-plugin-config-mode-bot")).toBeTruthy();
  });

  it("defaults Discord to the Bot Token config mode (defaultPriority)", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [plugin({ id: "discord", name: "Discord" })],
    });
    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:discord]")} />,
      { elizaCloudConnected: true },
    );
    await screen.findByText("Discord Configuration");

    expect(
      screen
        .getByTestId("inline-plugin-config-mode-bot")
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // Config form (not OAuth block) is shown for the default bot mode.
    expect(
      container.querySelector('input[data-config-key="TOKEN"]'),
    ).toBeTruthy();
    expect(screen.queryByTestId("inline-plugin-config-oauth")).toBeNull();
  });
});

// ── OAuth hand-off ──────────────────────────────────────────────────

describe("connector-setup card — OAuth sign-in", () => {
  it("switching to the OAuth mode reveals the Sign in button and hides the env form", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [plugin({ id: "discord", name: "Discord" })],
    });
    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:discord]")} />,
      { elizaCloudConnected: true },
    );
    await screen.findByText("Discord Configuration");

    fireEvent.click(screen.getByTestId("inline-plugin-config-mode-managed"));

    expect(screen.getByTestId("inline-plugin-config-oauth-btn")).toBeTruthy();
    // OAuth mode owns the body — the env form is gone.
    expect(
      container.querySelector('input[data-config-key="TOKEN"]'),
    ).toBeNull();
    // The visible fallback toggle away from OAuth is present.
    expect(screen.getByTestId("inline-plugin-config-use-apikey")).toBeTruthy();
  });

  it("Sign in opens the server-returned https authorization URL", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [plugin({ id: "discord", name: "Discord" })],
    });
    clientMock.startConnectorAccountOAuth.mockResolvedValue({
      ok: true,
      authUrl: "https://discord.com/oauth2/authorize?client_id=1",
    });
    withApp(<MessageContent message={assistant("[CONFIG:discord]")} />, {
      elizaCloudConnected: true,
    });
    await screen.findByText("Discord Configuration");
    fireEvent.click(screen.getByTestId("inline-plugin-config-mode-managed"));

    fireEvent.click(screen.getByTestId("inline-plugin-config-oauth-btn"));

    await waitFor(() => {
      expect(clientMock.startConnectorAccountOAuth).toHaveBeenCalledWith(
        "discord",
        "discord",
        {},
      );
    });
    await waitFor(() => {
      expect(windowOpenMock).toHaveBeenCalledWith(
        "https://discord.com/oauth2/authorize?client_id=1",
        "_blank",
        "noopener,noreferrer",
      );
    });
  });

  it("a non-https authorization URL is rejected and surfaces an error (never opened)", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [plugin({ id: "discord", name: "Discord" })],
    });
    clientMock.startConnectorAccountOAuth.mockResolvedValue({
      ok: false,
      authUrl: "javascript:alert(1)",
      error: "bad url",
    });
    withApp(<MessageContent message={assistant("[CONFIG:discord]")} />, {
      elizaCloudConnected: true,
    });
    await screen.findByText("Discord Configuration");
    fireEvent.click(screen.getByTestId("inline-plugin-config-mode-managed"));

    fireEvent.click(screen.getByTestId("inline-plugin-config-oauth-btn"));

    await screen.findByText("bad url");
    expect(windowOpenMock).not.toHaveBeenCalled();
  });

  it("the fallback toggle switches from OAuth to the API-key/config form", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [plugin({ id: "discord", name: "Discord" })],
    });
    const { container } = withApp(
      <MessageContent message={assistant("[CONFIG:discord]")} />,
      { elizaCloudConnected: true },
    );
    await screen.findByText("Discord Configuration");
    fireEvent.click(screen.getByTestId("inline-plugin-config-mode-managed"));
    expect(screen.getByTestId("inline-plugin-config-oauth")).toBeTruthy();

    fireEvent.click(screen.getByTestId("inline-plugin-config-use-apikey"));

    // Back to the env form; OAuth block gone.
    expect(
      container.querySelector('input[data-config-key="TOKEN"]'),
    ).toBeTruthy();
    expect(screen.queryByTestId("inline-plugin-config-oauth")).toBeNull();
  });
});

// ── Discord desktop one-click pairing ───────────────────────────────

describe("connector-setup card — Discord desktop pairing", () => {
  it("the Desktop App mode offers a one-click authorize that calls authorizeDiscordLocal", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [plugin({ id: "discord", name: "Discord" })],
    });
    clientMock.authorizeDiscordLocal.mockResolvedValue({ ok: true });
    withApp(<MessageContent message={assistant("[CONFIG:discord]")} />, {
      elizaCloudConnected: true,
    });
    await screen.findByText("Discord Configuration");

    fireEvent.click(screen.getByTestId("inline-plugin-config-mode-local"));
    fireEvent.click(screen.getByTestId("inline-plugin-config-local-btn"));

    await waitFor(() => {
      expect(clientMock.authorizeDiscordLocal).toHaveBeenCalledTimes(1);
    });
  });
});

// ── collapse-on-connect with a mode switch present ──────────────────

describe("connector-setup card — collapse-on-connect with modes", () => {
  it("a connected connector still mounts collapsed even with a mode switch", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [
        plugin({
          id: "discord",
          name: "Discord",
          enabled: true,
          configured: true,
        }),
      ],
    });
    withApp(<MessageContent message={assistant("[CONFIG:discord]")} />, {
      elizaCloudConnected: true,
    });
    await screen.findByText("Discord Configuration");
    expect(
      screen
        .getByTestId("inline-plugin-config-chevron")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen.getByTestId("inline-plugin-config-summary").textContent,
    ).toContain("Discord is connected.");
    expect(setActionNoticeMock).not.toHaveBeenCalled();
    expect(sendActionMessageMock).not.toHaveBeenCalled();
  });

  it("acknowledges a server-confirmed OAuth connection and offers to continue once", async () => {
    window.localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "cloud:agent-1",
        kind: "cloud",
        label: "Eliza",
        cloudRuntimeAgentId: "agent-1",
        cloudRuntime: "dedicated",
      }),
    );
    const prefill = vi.fn();
    window.addEventListener(CHAT_PREFILL_EVENT, prefill);
    clientMock.getPlugins
      .mockResolvedValueOnce({
        plugins: [plugin({ id: "discord", name: "Discord" })],
      })
      .mockResolvedValue({
        plugins: [
          plugin({
            id: "discord",
            name: "Discord",
            enabled: true,
            configured: true,
          }),
        ],
      });
    clientMock.startConnectorAccountOAuth.mockResolvedValue({
      ok: true,
      authUrl: "https://discord.com/oauth2/authorize?client_id=1",
    });
    withApp(<MessageContent message={assistant("[CONFIG:discord]")} />, {
      elizaCloudConnected: true,
    });
    await screen.findByText("Discord Configuration");
    fireEvent.click(screen.getByTestId("inline-plugin-config-mode-managed"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    persistCapabilityConnectorContinuation(
      {
        version: 1,
        kind: "capability_handoff",
        capabilityId: "calendar",
        label: "Calendar",
        availability: "needs_workspace",
        reason: "Calendar needs your personal workspace.",
        currentTier: "shared",
        requiredTier: "personal",
        nextAction: "upgrade_workspace",
        requiresConfirmation: true,
        cta: {
          label: "Set up personal workspace",
          href: "/cloud/agents/agent-1",
        },
        continuation: {
          originalIntent: "Move tomorrow's meeting to 3pm",
          clientMessageId: "turn-1",
        },
      },
      "agent-1",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("inline-plugin-config-oauth-btn"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(setActionNoticeMock).toHaveBeenCalledWith(
      "Discord connected.",
      "success",
      4_200,
    );
    expect(sendActionMessageMock).not.toHaveBeenCalled();
    expect(prefill).toHaveBeenCalledTimes(1);
    const prefillEvent = prefill.mock.calls[0]?.[0];
    expect(prefillEvent).toBeInstanceOf(CustomEvent);
    if (!(prefillEvent instanceof CustomEvent)) {
      throw new Error("Expected chat prefill event");
    }
    expect(prefillEvent.detail).toEqual({
      text: "Move tomorrow's meeting to 3pm",
      select: true,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(sendActionMessageMock).not.toHaveBeenCalled();
    expect(prefill).toHaveBeenCalledTimes(1);
    window.removeEventListener(CHAT_PREFILL_EVENT, prefill);
  });
});
