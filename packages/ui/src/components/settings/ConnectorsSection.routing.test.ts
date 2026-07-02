// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  getConnectorModes,
  modeToSetupPluginId,
} from "../connectors/ConnectorModeSelector.helpers";
import { hasConnectorSetupPanel } from "../connectors/ConnectorSetupPanel.helpers";
import { shouldRenderConnectorConfigForm } from "./ConnectorsSection";

/**
 * Locks the Settings → Connectors mode-routing contract: the generic env-var
 * config form must surface for `local-config` modes (Discord bot token, etc.)
 * WITHOUT cannibalising the dedicated setup surfaces that `local-setup` modes
 * still need (iMessage Full-Disk-Access status, Signal/WhatsApp QR pairing,
 * Discord/Telegram desktop panels). Regression guard for the
 * "gate on parameters.length" bug that hid those panels.
 */
function routeFor(connectorId: string, modeId: string, cloud = false) {
  const modes = getConnectorModes(connectorId, { elizaCloudConnected: cloud });
  const mode = modes.find((m) => m.id === modeId);
  if (!mode) throw new Error(`mode "${modeId}" not found for "${connectorId}"`);
  const setupPluginId = modeToSetupPluginId(connectorId, modeId);
  const showForm = shouldRenderConnectorConfigForm({
    managementMode: mode.managementMode,
    // The connector plugin declares parameters; the form gate must still defer
    // to the mode kind, not to the mere presence of parameters.
    hasParameters: true,
    setupTargetsPlugin: setupPluginId === connectorId,
  });
  return { managementMode: mode.managementMode, setupPluginId, showForm };
}

describe("ConnectorsSection mode routing", () => {
  it("renders the config form only for local-config bot/credential modes", () => {
    expect(routeFor("discord", "bot").showForm).toBe(true);
    expect(routeFor("telegram", "bot").showForm).toBe(true);
    expect(routeFor("whatsapp", "business").showForm).toBe(true);
  });

  it("keeps dedicated setup panels for local-setup modes (the regression)", () => {
    for (const [connectorId, modeId, expectedSetupId] of [
      ["imessage", "direct", "imessage"],
      ["signal", "qr", "signal"],
      ["whatsapp", "qr", "whatsapp"],
      ["discord", "local", "discordlocal"],
      ["telegram", "account", "telegramaccount"],
    ] as const) {
      const route = routeFor(connectorId, modeId);
      expect(route.showForm).toBe(false);
      expect(route.setupPluginId).toBe(expectedSetupId);
      // the dedicated panel must remain reachable for that target
      expect(hasConnectorSetupPanel(expectedSetupId)).toBe(true);
    }
  });

  it("routes a local-config sub-plugin mode (iMessage→BlueBubbles) to its own panel, not the env form", () => {
    const route = routeFor("imessage", "bluebubbles");
    expect(route.managementMode).toBe("local-config");
    expect(route.setupPluginId).toBe("bluebubbles");
    // setup target is a different plugin → no generic form for the imessage row
    expect(route.showForm).toBe(false);
    expect(hasConnectorSetupPanel("bluebubbles")).toBe(true);
  });

  it("never shows the env form for a local-setup mode even with parameters", () => {
    expect(
      shouldRenderConnectorConfigForm({
        managementMode: "local-setup",
        hasParameters: true,
        setupTargetsPlugin: true,
      }),
    ).toBe(false);
    expect(
      shouldRenderConnectorConfigForm({
        managementMode: "local-config",
        hasParameters: true,
        setupTargetsPlugin: true,
      }),
    ).toBe(true);
  });

  it("shows the credential form for connectors with NO declared mode list (farcaster, bluesky, …)", () => {
    // Connectors outside the hardcoded mode map fall through with an undefined
    // selected mode; when they declare parameters, the env form IS their setup
    // surface — not the dead-end "uses its own setup surface" text.
    for (const connectorId of ["farcaster", "bluesky", "matrix", "nostr"]) {
      expect(getConnectorModes(connectorId, {}).length).toBe(0);
    }
    expect(
      shouldRenderConnectorConfigForm({
        managementMode: undefined,
        hasParameters: true,
        setupTargetsPlugin: true,
      }),
    ).toBe(true);
    // …but a no-mode connector with no parameters still has nothing to render.
    expect(
      shouldRenderConnectorConfigForm({
        managementMode: undefined,
        hasParameters: false,
        setupTargetsPlugin: true,
      }),
    ).toBe(false);
  });
});
