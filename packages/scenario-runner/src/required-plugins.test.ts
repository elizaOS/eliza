/** Tests declared production-plugin registration and package identity resolution. */

import type { AgentRuntime, Plugin } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  pluginPackageIsRegistered,
  registerScenarioRequiredPlugins,
} from "./required-plugins.ts";

function runtimeWith(plugin: Plugin): Pick<AgentRuntime, "plugins"> {
  return { plugins: [plugin] };
}

describe("scenario required plugin registration", () => {
  it("loads and registers Maps for a simulated live-model runtime", async () => {
    const plugins: Plugin[] = [];
    const registerPlugin = vi.fn(async (plugin: Plugin) => {
      plugins.push(plugin);
    });
    const runtime = { plugins, registerPlugin } as unknown as Pick<
      AgentRuntime,
      "plugins" | "registerPlugin"
    >;

    await expect(
      registerScenarioRequiredPlugins(
        runtime,
        ["@elizaos/plugin-maps"],
        "simulated",
      ),
    ).resolves.toEqual(["@elizaos/plugin-maps"]);
    expect(registerPlugin).toHaveBeenCalledOnce();
    expect(plugins.map((plugin) => plugin.name)).toEqual(["maps"]);
    expect(plugins[0]?.actions?.map((action) => action.name)).toContain(
      "MAPS_SAVE",
    );
  });

  it("does not register an already-present declared plugin twice", async () => {
    const plugins: Plugin[] = [
      { name: "maps", description: "Already registered Maps", actions: [] },
    ];
    const registerPlugin = vi.fn(async (_plugin: Plugin) => undefined);
    const runtime = { plugins, registerPlugin } as unknown as Pick<
      AgentRuntime,
      "plugins" | "registerPlugin"
    >;

    await registerScenarioRequiredPlugins(
      runtime,
      ["@elizaos/plugin-maps"],
      "simulated",
    );
    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it("recognizes a package by packageName when its runtime name is intentionally different", () => {
    const runtime = runtimeWith({
      name: "elizaOSCloud",
      packageName: "@elizaos/plugin-elizacloud",
      description: "Cloud plugin with a stable legacy runtime identity.",
    });

    expect(
      pluginPackageIsRegistered(runtime, "@elizaos/plugin-elizacloud"),
    ).toBe(true);
  });

  it("does not treat an unrelated package as registered", () => {
    const runtime = runtimeWith({
      name: "elizaOSCloud",
      packageName: "@elizaos/plugin-elizacloud",
      description: "Cloud plugin with a stable legacy runtime identity.",
    });

    expect(pluginPackageIsRegistered(runtime, "@elizaos/plugin-openai")).toBe(
      false,
    );
  });
});
