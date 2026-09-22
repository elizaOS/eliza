/**
 * View-kind taxonomy filtering in the view registry.
 *
 * Verifies that `listViews` honours the four-kind taxonomy: system/release are
 * always listed, developer is gated by `developerMode`, preview is gated by
 * `includeAllKinds`, and the dashboard endpoint's `includeAllKinds: true`
 * surfaces everything (so the client can apply the user's Settings toggles).
 */

import { AgentRuntime, createCharacter, type Plugin } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { listViews } from "./views-registry.js";

const PLUGIN_NAME = "@elizaos/plugin-view-kind-fixture";

function fixturePlugin(): Plugin {
  return {
    name: PLUGIN_NAME,
    description: "kind fixture",
    views: [
      { id: "vk-system", label: "Sys", viewKind: "system", bundleUrl: "x" },
      { id: "vk-release", label: "Rel", viewKind: "release", bundleUrl: "x" },
      { id: "vk-dev", label: "Dev", viewKind: "developer", bundleUrl: "x" },
      {
        id: "vk-preview",
        label: "Prev",
        viewKind: "preview",
        group: "wallet",
        bundleUrl: "x",
      },
      // legacy gate still maps to developer
      { id: "vk-legacy", label: "Legacy", developerOnly: true, bundleUrl: "x" },
    ],
  } as Plugin;
}

async function register() {
  const { registerPluginViews } = await import("./views-registry.js");
  await registerPluginViews(runtime, fixturePlugin(), {
    pluginDir: "/tmp/does-not-matter",
  });
}

function ids(entries: { id: string }[]): string[] {
  return entries.map((e) => e.id).filter((id) => id.startsWith("vk-"));
}

describe("listViews kind filtering", () => {
  it("default (no flags): only system + release", async () => {
    await register();
    expect(ids(listViews(runtime)).sort()).toEqual(["vk-release", "vk-system"]);
  });

  it("developerMode: adds developer (incl. legacy developerOnly), not preview", async () => {
    await register();
    expect(ids(listViews(runtime, { developerMode: true })).sort()).toEqual([
      "vk-dev",
      "vk-legacy",
      "vk-release",
      "vk-system",
    ]);
  });

  it("includeAllKinds: surfaces every kind including preview", async () => {
    await register();
    expect(ids(listViews(runtime, { includeAllKinds: true })).sort()).toEqual([
      "vk-dev",
      "vk-legacy",
      "vk-preview",
      "vk-release",
      "vk-system",
    ]);
  });

  it("preserves app-shell grouping metadata for client launcher curation", async () => {
    await register();
    const grouped = listViews(runtime, { includeAllKinds: true }).find(
      (view) => view.id === "vk-preview",
    );
    expect(grouped?.group).toBe("wallet");
  });
});

let runtime: AgentRuntime;
beforeEach(() => {
  runtime = new AgentRuntime({
    character: createCharacter({ name: "View fixture" }),
    enableAutonomy: false,
  });
});
