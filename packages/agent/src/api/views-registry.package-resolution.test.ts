/**
 * Plugin package-dir resolution for view registration.
 *
 * A plugin's short name can collide with an unrelated published npm package
 * (the concrete case: plugin "birdclaw" vs the `birdclaw` CLI on npm, which
 * Bun can resolve from its install cache). The registry must prefer the
 * canonical `@elizaos/plugin-<name>` package so the view bundle is served
 * from the actual plugin directory, and must resolve a real workspace plugin
 * end to end.
 */

import type { Plugin } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  listViews,
  pluginPackageNameCandidates,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.js";

describe("pluginPackageNameCandidates", () => {
  it("prefers the canonical @elizaos/plugin-* package over the bare short name", () => {
    expect(pluginPackageNameCandidates("birdclaw")).toEqual([
      "@elizaos/plugin-birdclaw",
      "birdclaw",
    ]);
  });

  it("uses a scoped plugin name as-is", () => {
    expect(pluginPackageNameCandidates("@elizaos/plugin-inbox")).toEqual([
      "@elizaos/plugin-inbox",
    ]);
    expect(pluginPackageNameCandidates("@acme/plugin-custom")).toEqual([
      "@acme/plugin-custom",
    ]);
  });
});

describe("registerPluginViews package-dir resolution", () => {
  const PLUGIN_NAME = "birdclaw";

  afterEach(() => {
    unregisterPluginViews(PLUGIN_NAME);
  });

  it("resolves a short-named workspace plugin to its plugins/plugin-<name> dir", async () => {
    const plugin: Plugin = {
      name: PLUGIN_NAME,
      description: "resolution fixture",
      views: [
        {
          id: "birdclaw-resolution-fixture",
          label: "Birdclaw fixture",
          bundlePath: "dist/views/bundle.js",
        },
      ],
    } as Plugin;

    await registerPluginViews(plugin);

    const entry = listViews({ includeAllKinds: true }).find(
      (view) => view.id === "birdclaw-resolution-fixture",
    );
    expect(entry).toBeDefined();
    // Normalized so the assertion holds on Windows path separators too.
    const pluginDir = (entry?.pluginDir ?? "").split("\\").join("/");
    expect(pluginDir).toContain("plugins/plugin-birdclaw");
  });
});
