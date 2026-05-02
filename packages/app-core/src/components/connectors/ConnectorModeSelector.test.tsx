// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectorModeSelector,
  getConnectorModes,
  getDefaultConnectorModeId,
  modeToSetupPluginId,
} from "./ConnectorModeSelector";

vi.mock("../../state", () => ({
  useApp: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

describe("ConnectorModeSelector", () => {
  afterEach(() => {
    cleanup();
  });

  it("prefers OAuth-capable modes when Eliza Cloud is connected and falls back sanely", () => {
    expect(
      getDefaultConnectorModeId(
        "discord",
        getConnectorModes("discord", { elizaCloudConnected: true }),
      ),
    ).toBe("managed");
    expect(
      getDefaultConnectorModeId(
        "slack",
        getConnectorModes("slack", { elizaCloudConnected: true }),
      ),
    ).toBe("oauth");
    expect(
      getDefaultConnectorModeId(
        "twitter",
        getConnectorModes("twitter", { elizaCloudConnected: true }),
      ),
    ).toBe("oauth");
    expect(
      getDefaultConnectorModeId(
        "telegram",
        getConnectorModes("telegram", { elizaCloudConnected: true }),
      ),
    ).toBe("bot");
    expect(
      getDefaultConnectorModeId(
        "discord",
        getConnectorModes("discord", { elizaCloudConnected: false }),
      ),
    ).toBe("bot");
  });

  it("only exposes managed Discord when Eliza Cloud is connected", () => {
    expect(
      getConnectorModes("discord", { elizaCloudConnected: false }).map(
        (mode) => mode.id,
      ),
    ).toEqual(["local", "bot"]);
    expect(
      getConnectorModes("discord", { elizaCloudConnected: true }).map(
        (mode) => mode.id,
      ),
    ).toEqual(["managed", "local", "bot"]);
  });

  it("exposes Slack and X/Twitter OAuth when Eliza Cloud is connected", () => {
    expect(
      getConnectorModes("slack", { elizaCloudConnected: false }).map(
        (mode) => mode.id,
      ),
    ).toEqual(["socket"]);
    expect(
      getConnectorModes("slack", { elizaCloudConnected: true }).map(
        (mode) => mode.id,
      ),
    ).toEqual(["oauth", "socket"]);
    expect(
      getConnectorModes("twitter", { elizaCloudConnected: false }).map(
        (mode) => mode.id,
      ),
    ).toEqual(["local-oauth", "developer"]);
    expect(
      getConnectorModes("twitter", { elizaCloudConnected: true }).map(
        (mode) => mode.id,
      ),
    ).toEqual(["oauth", "local-oauth", "developer"]);
  });

  it("routes account-style setup modes to their dedicated setup panels", () => {
    expect(modeToSetupPluginId("slack", "oauth")).toBe("slack");
    expect(modeToSetupPluginId("twitter", "local-oauth")).toBe("twitter");
    expect(modeToSetupPluginId("telegram", "cloud-bot")).toBe("telegram");
    expect(modeToSetupPluginId("telegram", "bot")).toBe("telegram");
    expect(modeToSetupPluginId("telegram", "account")).toBe("telegramaccount");
    expect(modeToSetupPluginId("discord", "local")).toBe("discordlocal");
    expect(modeToSetupPluginId("discord", "managed")).toBe("discord");
  });

  it("renders stable controls and notifies mode changes", () => {
    const onModeChange = vi.fn();
    render(
      <ConnectorModeSelector
        connectorId="discord"
        selectedMode="bot"
        onModeChange={onModeChange}
        elizaCloudConnected
      />,
    );

    fireEvent.click(screen.getByTestId("connector-mode-discord-managed"));

    expect(onModeChange).toHaveBeenCalledWith("managed");
    expect(
      screen
        .getByTestId("connector-mode-discord-managed")
        .getAttribute("title"),
    ).toBe(
      "Invite the shared Eliza Cloud Discord gateway, nickname it to your agent, and route messages down to this app.",
    );
  });
});
