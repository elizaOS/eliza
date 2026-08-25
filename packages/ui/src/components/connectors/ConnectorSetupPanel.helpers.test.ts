/**
 * Unit tests for ConnectorSetupPanel helpers: validates plugin id normalization and registry lookup.
 */
import { describe, expect, it } from "vitest";
import {
  connectorSetupRegistry,
  hasConnectorSetupPanel,
  normalizePluginId,
  registerConnectorSetupPanel,
} from "./ConnectorSetupPanel.helpers.ts";

describe("ConnectorSetupPanel.helpers", () => {
  it("normalizes plugin id stripping punctuation and whitespace", () => {
    expect(normalizePluginId("@elizaos/plugin-telegram")).toBe(
      "elizaosplugintelegram",
    );
    expect(normalizePluginId("  Discord-Local  ")).toBe("discordlocal");
  });

  it("registers custom setup panel component and checks existence", () => {
    const dummyComponent = () => null;
    registerConnectorSetupPanel("my-custom-plugin", dummyComponent);
    expect(connectorSetupRegistry.has("mycustomplugin")).toBe(true);
    expect(hasConnectorSetupPanel("my-custom-plugin")).toBe(true);
  });

  it("returns true for built-in connector panels", () => {
    expect(hasConnectorSetupPanel("whatsapp")).toBe(true);
    expect(hasConnectorSetupPanel("imessage")).toBe(true);
  });
});
