import { describe, expect, it } from "vitest";
import {
  getConnectorModes,
  getDefaultConnectorModeId,
  modeToSetupPluginId,
} from "./ConnectorModeSelector.helpers";
import { hasConnectorSetupPanel } from "./ConnectorSetupPanel.helpers";
import {
  type ConnectorModeDeclaration,
  registerConnectorModes,
} from "./connector-mode-registry";

/**
 * Seam test for #12094 item 1: the connector setup mode list and copy must come
 * from plugin-declared metadata, not a per-connector switch in the ui package.
 * A connector plugin whose id appears nowhere in ui source can register its
 * modes and get a fully functioning mode selector.
 */
describe("connector mode registry seam", () => {
  it("renders a connector absent from ui source purely from its declared modes", () => {
    // "acmechat" is a fictional connector plugin — it is not referenced in any
    // switch or map in the ui package. It only exists via registration.
    const declared: ConnectorModeDeclaration[] = [
      {
        id: "cloud",
        label: "Acme Cloud",
        description: "Route Acme Chat through the Acme Cloud gateway.",
        managementMode: "cloud-managed",
        setupPluginId: "acmechat",
        cloudOnly: true,
        defaultPriority: 1,
      },
      {
        id: "token",
        label: "API Token",
        description: "Use an Acme Chat API token from the developer console.",
        managementMode: "local-config",
        setupPluginId: "acmechat",
        defaultPriority: 2,
      },
    ];
    registerConnectorModes("@elizaos/plugin-acmechat", declared);

    // Cloud disconnected: the cloud-only mode is filtered out, leaving the
    // declared token mode — no hardcoded branch required.
    const offline = getConnectorModes("acmechat", {
      elizaCloudConnected: false,
    });
    expect(offline.map((mode) => mode.id)).toEqual(["token"]);
    expect(offline[0]?.label).toBe("API Token");
    expect(offline[0]?.managementMode).toBe("local-config");

    // Cloud connected: both declared modes render in declared order.
    const online = getConnectorModes("acmechat", { elizaCloudConnected: true });
    expect(online.map((mode) => mode.id)).toEqual(["cloud", "token"]);

    // Setup routing and default selection derive from the declaration.
    expect(modeToSetupPluginId("acmechat", "token")).toBe("acmechat");
    expect(modeToSetupPluginId("acmechat", "cloud")).toBe("acmechat");
    expect(getDefaultConnectorModeId("acmechat", online)).toBe("cloud");
    expect(getDefaultConnectorModeId("acmechat", offline)).toBe("token");

    // The connector id is accepted in its raw namespaced form too.
    expect(
      getConnectorModes("@elizaos/plugin-acmechat", {}).map((mode) => mode.id),
    ).toEqual(["token"]);
  });

  it("preserves the built-in Discord modes (cloud gating + default)", () => {
    const offline = getConnectorModes("discord", {
      elizaCloudConnected: false,
    });
    expect(offline.map((mode) => mode.id)).toEqual(["local", "bot"]);
    expect(getDefaultConnectorModeId("discord", offline)).toBe("bot");

    const online = getConnectorModes("discord", { elizaCloudConnected: true });
    expect(online.map((mode) => mode.id)).toEqual(["managed", "local", "bot"]);
    expect(modeToSetupPluginId("discord", "local")).toBe("discordlocal");
    expect(modeToSetupPluginId("discord", "bot")).toBe("discord");
  });

  it("treats twitter as an alias of x (dead case is gone, not the behavior)", () => {
    expect(getConnectorModes("twitter", {}).map((m) => m.id)).toEqual(
      getConnectorModes("x", {}).map((m) => m.id),
    );
    expect(modeToSetupPluginId("twitter", "developer")).toBe("x");
  });

  it("resolves the built-in setup panels for declared local-setup modes", () => {
    expect(hasConnectorSetupPanel("discordlocal")).toBe(true);
    expect(hasConnectorSetupPanel("telegramaccount")).toBe(true);
    expect(hasConnectorSetupPanel("bluebubbles")).toBe(true);
    // A namespaced telegram plugin id still resolves to the bot panel.
    expect(hasConnectorSetupPanel("@elizaos/plugin-telegram")).toBe(true);
    // A connector with no built-in panel and no declared modes stays false.
    expect(hasConnectorSetupPanel("acmechat")).toBe(false);
    expect(getConnectorModes("farcaster", {})).toHaveLength(0);
  });
});
