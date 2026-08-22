/**
 * Guards the generated short-id -> plugin-package map: the alias contract is
 * preserved in the built artifact, keys are derived only from entries' explicit
 * `shortIds` markers, and duplicate short-id claims across plugins are rejected
 * (fail-loud on drift instead of silently letting one entry win). This replaces
 * the hand-synced OPTIONAL_PLUGIN_MAP alias table for registry-owned plugins.
 */
import { describe, expect, it } from "vitest";
import { collectShortIdPluginMap } from "./generate";
import type { RegistryEntry } from "./schema";
import shortIdPluginMap from "./short-id-plugin-map.json" with { type: "json" };

const expectedShortIdPluginMap = {
  "agent-wallet": "@elizaos/plugin-wallet",
  agent_wallet: "@elizaos/plugin-wallet",
  "app-browser": "@elizaos/plugin-browser",
  appBrowser: "@elizaos/plugin-browser",
  browser: "@elizaos/plugin-browser",
  "browser-bridge": "@elizaos/plugin-browser",
  browserBridge: "@elizaos/plugin-browser",
  "coding-agent": "@elizaos/plugin-coding-tools",
  "coding-tools": "@elizaos/plugin-coding-tools",
  codingAgent: "@elizaos/plugin-coding-tools",
  codingTools: "@elizaos/plugin-coding-tools",
  computeruse: "@elizaos/plugin-computeruse",
  discordLocal: "@elizaos/plugin-discord",
  "eliza-browser": "@elizaos/plugin-browser",
  elizaBrowser: "@elizaos/plugin-browser",
  elizacloud: "@elizaos/plugin-elizacloud",
  evm: "@elizaos/plugin-wallet",
  form: "@elizaos/plugin-form",
  ollama: "@elizaos/plugin-zerollama",
  selfcontrol: "@elizaos/plugin-personal-assistant",
  solana: "@elizaos/plugin-wallet",
  vision: "@elizaos/plugin-vision",
  wallet: "@elizaos/plugin-wallet",
  zerollama: "@elizaos/plugin-zerollama",
};

function shortIdEntry(
  id: string,
  npmName: string,
  shortIds: string[],
): RegistryEntry {
  return {
    id,
    name: id,
    npmName,
    source: "bundled",
    tags: [],
    config: {},
    render: {
      visible: true,
      pinTo: [],
      style: "card",
      group: "apps",
      actions: [],
    },
    resources: {},
    dependsOn: [],
    channels: [],
    shortIds,
    kind: "plugin",
    subtype: "feature",
  };
}

describe("short-id plugin map generation", () => {
  it("keeps the short-id alias contract in the generated artifact", () => {
    expect(shortIdPluginMap).toEqual(expectedShortIdPluginMap);
  });

  it("derives short ids only from entries' explicit shortIds markers", () => {
    expect(
      collectShortIdPluginMap([
        shortIdEntry("aliased", "@elizaos/plugin-aliased", ["ali", "aliased"]),
        shortIdEntry("bare", "@elizaos/plugin-bare", []),
      ]),
    ).toEqual({
      ali: "@elizaos/plugin-aliased",
      aliased: "@elizaos/plugin-aliased",
    });
  });

  it("ignores entries without an npmName", () => {
    const entry = shortIdEntry("orphan", "@elizaos/plugin-orphan", ["orphan"]);
    // Simulate a metadata-only entry that declares aliases but ships no package.
    const orphan = { ...entry, npmName: undefined } as RegistryEntry;
    expect(collectShortIdPluginMap([orphan])).toEqual({});
  });

  it("rejects duplicate short-id claims across plugins (fail-loud on drift)", () => {
    expect(() =>
      collectShortIdPluginMap([
        shortIdEntry("one", "@elizaos/plugin-one", ["dupe"]),
        shortIdEntry("two", "@elizaos/plugin-two", ["dupe"]),
      ]),
    ).toThrow(
      'short id "dupe" claimed by both @elizaos/plugin-one and @elizaos/plugin-two',
    );
  });

  it("allows the same short id repeated within one entry's own package", () => {
    expect(
      collectShortIdPluginMap([
        shortIdEntry("same", "@elizaos/plugin-same", ["same", "same"]),
      ]),
    ).toEqual({ same: "@elizaos/plugin-same" });
  });
});
