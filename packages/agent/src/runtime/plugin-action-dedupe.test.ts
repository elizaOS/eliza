/**
 * Unit tests for deduplicating actions across ordered plugin sets during agent boot.
 */

import type { Action, Plugin } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { deduplicatePluginActions } from "./plugin-action-dedupe.js";

function makeAction(name: string): Action {
  return {
    name,
    description: `Description for ${name}`,
    similes: [],
    examples: [],
    handler: async () => true,
    validate: async () => true,
  };
}

describe("plugin-action-dedupe", () => {
  it("keeps only first occurrence of actions across plugins", () => {
    const pluginA: Plugin = {
      name: "plugin-a",
      description: "Plugin A",
      actions: [makeAction("SEND_MESSAGE"), makeAction("SEARCH")],
    };

    const pluginB: Plugin = {
      name: "plugin-b",
      description: "Plugin B",
      actions: [makeAction("SEND_MESSAGE"), makeAction("FETCH_WEATHER")],
    };

    const plugins = [pluginA, pluginB];
    deduplicatePluginActions(plugins);

    expect(pluginA.actions?.map((a) => a.name)).toEqual([
      "SEND_MESSAGE",
      "SEARCH",
    ]);
    expect(pluginB.actions?.map((a) => a.name)).toEqual(["FETCH_WEATHER"]);
  });

  it("handles plugins with undefined actions safely", () => {
    const pluginEmpty: Plugin = {
      name: "empty-plugin",
      description: "No actions",
    };

    const pluginWithActions: Plugin = {
      name: "action-plugin",
      description: "Has action",
      actions: [makeAction("PING")],
    };

    const plugins = [pluginEmpty, pluginWithActions];
    deduplicatePluginActions(plugins);

    expect(pluginEmpty.actions).toBeUndefined();
    expect(pluginWithActions.actions?.map((a) => a.name)).toEqual(["PING"]);
  });
});
