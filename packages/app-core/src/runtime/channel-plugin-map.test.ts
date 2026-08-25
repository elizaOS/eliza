/**
 * Unit coverage for CHANNEL_PLUGIN_MAP, the generated channel-name → plugin
 * package lookup app-core re-exports from the first-party registry artifact.
 * The module has no mutators, queues, or comparators — these cases lock the
 * live mapping, missing-key lookup, alias sharing, and identity with the JSON
 * artifact. Drives the real module; no mocks.
 */

import generatedChannelPluginMap from "@elizaos/registry/first-party/channel-plugin-map.json" with {
  type: "json",
};
import { describe, expect, it } from "vitest";
import * as channelPluginMapModule from "./channel-plugin-map";
import { CHANNEL_PLUGIN_MAP } from "./channel-plugin-map";

const expectedChannelPluginMap: Record<string, string> = {
  blooio: "@elizaos/plugin-blooio",
  discord: "@elizaos/plugin-discord",
  discordLocal: "@elizaos/plugin-discord",
  googlechat: "@elizaos/plugin-google-workspace",
  imessage: "@elizaos/plugin-imessage",
  matrix: "@elizaos/plugin-matrix",
  mattermost: "@elizaos/plugin-mattermost",
  msteams: "@elizaos/plugin-msteams",
  slack: "@elizaos/plugin-slack",
  telegram: "@elizaos/plugin-telegram",
  twitter: "@elizaos/plugin-x",
  wechat: "@elizaos/plugin-wechat",
  whatsapp: "@elizaos/plugin-whatsapp",
  x: "@elizaos/plugin-x",
};

describe("CHANNEL_PLUGIN_MAP", () => {
  it("is the only export and re-exports the generated JSON artifact by identity", () => {
    expect(Object.keys(channelPluginMapModule)).toEqual(["CHANNEL_PLUGIN_MAP"]);
    expect(CHANNEL_PLUGIN_MAP).toBe(generatedChannelPluginMap);
    expect(CHANNEL_PLUGIN_MAP).toEqual(expectedChannelPluginMap);
  });

  it("resolves every shipped channel name to its owning plugin package", () => {
    expect(CHANNEL_PLUGIN_MAP.blooio).toBe("@elizaos/plugin-blooio");
    expect(CHANNEL_PLUGIN_MAP.discord).toBe("@elizaos/plugin-discord");
    expect(CHANNEL_PLUGIN_MAP.discordLocal).toBe("@elizaos/plugin-discord");
    expect(CHANNEL_PLUGIN_MAP.googlechat).toBe(
      "@elizaos/plugin-google-workspace",
    );
    expect(CHANNEL_PLUGIN_MAP.imessage).toBe("@elizaos/plugin-imessage");
    expect(CHANNEL_PLUGIN_MAP.matrix).toBe("@elizaos/plugin-matrix");
    expect(CHANNEL_PLUGIN_MAP.mattermost).toBe("@elizaos/plugin-mattermost");
    expect(CHANNEL_PLUGIN_MAP.msteams).toBe("@elizaos/plugin-msteams");
    expect(CHANNEL_PLUGIN_MAP.slack).toBe("@elizaos/plugin-slack");
    expect(CHANNEL_PLUGIN_MAP.telegram).toBe("@elizaos/plugin-telegram");
    expect(CHANNEL_PLUGIN_MAP.twitter).toBe("@elizaos/plugin-x");
    expect(CHANNEL_PLUGIN_MAP.wechat).toBe("@elizaos/plugin-wechat");
    expect(CHANNEL_PLUGIN_MAP.whatsapp).toBe("@elizaos/plugin-whatsapp");
    expect(CHANNEL_PLUGIN_MAP.x).toBe("@elizaos/plugin-x");
  });

  it("shares one plugin across alias keys rather than picking a winner", () => {
    expect(CHANNEL_PLUGIN_MAP.twitter).toBe(CHANNEL_PLUGIN_MAP.x);
    expect(CHANNEL_PLUGIN_MAP.discord).toBe(CHANNEL_PLUGIN_MAP.discordLocal);
  });

  it("returns undefined for missing, empty, whitespace, and case-mismatched names", () => {
    expect(CHANNEL_PLUGIN_MAP["not-a-channel"]).toBeUndefined();
    expect(CHANNEL_PLUGIN_MAP[""]).toBeUndefined();
    expect(CHANNEL_PLUGIN_MAP[" "]).toBeUndefined();
    expect(CHANNEL_PLUGIN_MAP.Discord).toBeUndefined();
    expect(CHANNEL_PLUGIN_MAP.TELEGRAM).toBeUndefined();
    expect(CHANNEL_PLUGIN_MAP.bluebubbles).toBeUndefined();
    expect(CHANNEL_PLUGIN_MAP.signal).toBeUndefined();
  });

  it("exposes a non-empty map whose keys are sorted and whose values are plugin packages", () => {
    const keys = Object.keys(CHANNEL_PLUGIN_MAP);
    expect(keys.length).toBe(Object.keys(expectedChannelPluginMap).length);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual([...keys].sort());
    for (const key of keys) {
      expect(key.trim()).toBe(key);
      expect(key.length).toBeGreaterThan(0);
      expect(CHANNEL_PLUGIN_MAP[key]).toMatch(/^@elizaos\/plugin-[a-z0-9-]+$/);
    }
  });
});
