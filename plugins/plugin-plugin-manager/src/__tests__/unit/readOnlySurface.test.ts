import { describe, expect, it } from "vitest";
import { pluginManagerPlugin } from "../../index";

describe("plugin-manager surface", () => {
  it("registers only the unified PLUGIN action", () => {
    const names = (pluginManagerPlugin.actions ?? []).map((a) => a.name).sort();
    expect(names).toEqual(["PLUGIN"]);
  });

  it("registers only canonical management similes", () => {
    const plugin = (pluginManagerPlugin.actions ?? []).find((a) => a.name === "PLUGIN");
    expect(plugin).toBeDefined();
    expect(plugin?.similes).toEqual(["PLUGIN_CONTROL", "MANAGE_PLUGINS"]);
  });

  it("keeps expected providers", () => {
    const providerNames = (pluginManagerPlugin.providers ?? []).map((p) => p.name).sort();

    expect(providerNames).toEqual(
      ["pluginConfigurationStatus", "pluginState", "registryPlugins"].sort()
    );
  });
});
