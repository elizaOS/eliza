/**
 * Mode projection for the in-chat connector-setup card. Asserts the card offers
 * exactly the modes the shared connector-mode registry declares (so the chat
 * card and the Settings connectors page can never disagree), classifies each
 * into the right widget affordance (oauth / config / local), drops cloud-only
 * modes when Eliza Cloud is not connected, and picks the registry's
 * default-priority mode. Pure module — no React.
 */

import { describe, expect, it } from "vitest";
import {
  type ConnectorWidgetMode,
  connectorWidgetModes,
  defaultConnectorWidgetModeId,
} from "./inline-connector-modes";

describe("connectorWidgetModes", () => {
  it("drops the cloud-only OAuth mode when cloud is not connected", () => {
    const offline = connectorWidgetModes("discord", {
      elizaCloudConnected: false,
    });
    expect(offline.some((m) => m.id === "managed")).toBe(false);
    expect(offline.some((m) => m.id === "bot")).toBe(true);
    expect(offline.some((m) => m.id === "local")).toBe(true);
  });

  it("offers the cloud-managed OAuth mode when cloud is connected", () => {
    const online = connectorWidgetModes("discord", {
      elizaCloudConnected: true,
    });
    const managed = online.find((m) => m.id === "managed");
    expect(managed?.kind).toBe("oauth");
  });

  it("classifies bot-token as config and desktop IPC as local", () => {
    const modes = connectorWidgetModes("discord", {
      elizaCloudConnected: true,
    });
    expect(modes.find((m) => m.id === "bot")?.kind).toBe("config");
    expect(modes.find((m) => m.id === "local")?.kind).toBe("local");
    // The local desktop mode points at its dedicated setup plugin.
    expect(modes.find((m) => m.id === "local")?.setupPluginId).toBe(
      "discordlocal",
    );
  });

  it("returns [] for a plugin with no declared modes (plain env form)", () => {
    expect(
      connectorWidgetModes("some-unknown-plugin", {
        elizaCloudConnected: true,
      }),
    ).toEqual([]);
  });
});

describe("defaultConnectorWidgetModeId", () => {
  it("honors the registry defaultPriority (Discord → bot token)", () => {
    const modes = connectorWidgetModes("discord", {
      elizaCloudConnected: true,
    });
    expect(defaultConnectorWidgetModeId("discord", modes)).toBe("bot");
  });

  it("prefers iMessage's zero-priority direct mode over earlier offered modes", () => {
    const modes = connectorWidgetModes("imessage", {
      elizaCloudConnected: true,
    });
    expect(modes[0]?.id).toBe("blooio");
    expect(defaultConnectorWidgetModeId("imessage", modes)).toBe("direct");
  });

  it("falls back to the first offered mode when none is ranked", () => {
    const modes: ConnectorWidgetMode[] = [
      {
        id: "unranked-first",
        label: "First mode",
        description: "An offered mode without a registry priority.",
        kind: "config",
        setupPluginId: "unranked-test-connector",
      },
      {
        id: "unranked-second",
        label: "Second mode",
        description: "Another offered mode without a registry priority.",
        kind: "local",
        setupPluginId: "unranked-test-connector",
      },
    ];
    expect(
      defaultConnectorWidgetModeId("unranked-test-connector", modes),
    ).toBe("unranked-first");
    expect(
      defaultConnectorWidgetModeId("unranked-test-connector", [...modes].reverse()),
    ).toBe("unranked-second");
  });

  it("returns null for an empty mode list", () => {
    expect(defaultConnectorWidgetModeId("unknown", [])).toBeNull();
  });
});
