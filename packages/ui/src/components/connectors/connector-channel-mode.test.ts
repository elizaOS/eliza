/** Verifies the connector channel-mode lens through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Covers the localStorage-backed Delegate/Bot lens store and how the lens
 * filters the connector-mode registry: per-connector support, per-mode
 * filtering in `getConnectorModes`, and lens-neutrality of unclassified
 * connectors. In-memory registry + jsdom localStorage, no runtime.
 */

import { afterEach, describe, expect, it } from "vitest";
import { getConnectorModes } from "./ConnectorModeSelector.helpers";
import {
  getConnectorChannelMode,
  setConnectorChannelMode,
} from "./connector-channel-mode";
import {
  connectorSupportsChannelMode,
  getConnectorModeHiddenConfigKeys,
} from "./connector-mode-registry";

afterEach(() => {
  setConnectorChannelMode("delegate");
  window.localStorage.clear();
});

describe("connector channel-mode store", () => {
  it("defaults to delegate and persists an explicit choice", () => {
    expect(getConnectorChannelMode()).toBe("delegate");
    setConnectorChannelMode("bot");
    expect(getConnectorChannelMode()).toBe("bot");
    expect(window.localStorage.getItem("eliza:connectors:channelMode")).toBe(
      "bot",
    );
  });
});

describe("connectorSupportsChannelMode", () => {
  it("includes role-classified plugin-managed identities", () => {
    // Slack's declared app-token modes are bots, while its account catalog also
    // exposes an OWNER OAuth inventory under Delegate.
    expect(connectorSupportsChannelMode("slack", "bot")).toBe(true);
    expect(connectorSupportsChannelMode("slack", "delegate")).toBe(true);
  });

  it("classifies delegate-only connectors out of the bot lens", () => {
    // Signal's single mode links a device to the owner's own account.
    expect(connectorSupportsChannelMode("signal", "delegate")).toBe(true);
    expect(connectorSupportsChannelMode("signal", "bot")).toBe(false);
  });

  it("keeps dual-identity connectors in both lenses", () => {
    for (const connector of ["discord", "telegram", "whatsapp", "imessage"]) {
      expect(connectorSupportsChannelMode(connector, "delegate")).toBe(true);
      expect(connectorSupportsChannelMode(connector, "bot")).toBe(true);
    }
  });

  it("classifies single-form connectors through the registered fallback", () => {
    // Bluesky's credential form configures the agent's own account → bot only.
    expect(connectorSupportsChannelMode("bluesky", "bot")).toBe(true);
    expect(connectorSupportsChannelMode("bluesky", "delegate")).toBe(false);
    // Instagram credentials are the owner's own account → delegate only.
    expect(connectorSupportsChannelMode("instagram", "delegate")).toBe(true);
    expect(connectorSupportsChannelMode("instagram", "bot")).toBe(false);
  });

  it("treats unknown connectors with no declared modes as lens-neutral", () => {
    expect(connectorSupportsChannelMode("acmechat-unknown", "delegate")).toBe(
      true,
    );
    expect(connectorSupportsChannelMode("acmechat-unknown", "bot")).toBe(true);
  });
});

describe("getConnectorModes channel-mode filtering", () => {
  it("keeps only the lens's modes for a dual-identity connector", () => {
    const delegate = getConnectorModes("telegram", {
      elizaCloudConnected: true,
      channelMode: "delegate",
    }).map((mode) => mode.id);
    const bot = getConnectorModes("telegram", {
      elizaCloudConnected: true,
      channelMode: "bot",
    }).map((mode) => mode.id);

    expect(delegate).toContain("account");
    expect(delegate).not.toContain("bot");
    expect(delegate).not.toContain("cloud-bot");
    expect(bot).toContain("bot");
    expect(bot).toContain("cloud-bot");
    expect(bot).not.toContain("account");
  });

  it("filters plugin-managed modes by their catalog account role", () => {
    const telegramDelegate = getConnectorModes("telegram", {
      channelMode: "delegate",
    }).map((mode) => mode.id);
    const telegramBot = getConnectorModes("telegram", {
      channelMode: "bot",
    }).map((mode) => mode.id);
    const slackDelegate = getConnectorModes("slack", {
      channelMode: "delegate",
    }).map((mode) => mode.id);
    const slackBot = getConnectorModes("slack", {
      channelMode: "bot",
    }).map((mode) => mode.id);

    expect(telegramDelegate).not.toContain("plugin-managed");
    expect(telegramBot).toContain("plugin-managed");
    expect(slackDelegate).toContain("plugin-managed");
    expect(slackBot).not.toContain("plugin-managed");
  });

  it("hides delegate-only QR settings from WhatsApp Business mode", () => {
    expect(getConnectorModeHiddenConfigKeys("whatsapp", "business")).toEqual([
      "WHATSAPP_AUTH_METHOD",
      "WHATSAPP_AUTH_DIR",
      "WHATSAPP_PRINT_QR",
    ]);
    expect(getConnectorModeHiddenConfigKeys("whatsapp", "qr")).toEqual([]);
  });

  it("leaves the mode list unfiltered when no lens is given", () => {
    const ids = getConnectorModes("telegram", {
      elizaCloudConnected: true,
    }).map((mode) => mode.id);
    expect(ids).toEqual(
      expect.arrayContaining(["account", "bot", "cloud-bot"]),
    );
  });
});
