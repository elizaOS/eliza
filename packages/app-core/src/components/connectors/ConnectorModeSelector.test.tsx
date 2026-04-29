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

  it("keeps developer credentials as the default Discord and Telegram mode", () => {
    expect(
      getDefaultConnectorModeId(
        "discord",
        getConnectorModes("discord", { elizaCloudConnected: true }),
      ),
    ).toBe("bot");
    expect(
      getDefaultConnectorModeId(
        "telegram",
        getConnectorModes("telegram", { elizaCloudConnected: true }),
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
    ).toEqual(["local", "bot", "managed"]);
  });

  it("routes account-style setup modes to their dedicated setup panels", () => {
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
    ).toBe("Use a shared gateway bot via Eliza Cloud OAuth");
  });
});
