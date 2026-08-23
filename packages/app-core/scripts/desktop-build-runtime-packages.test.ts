/** Guards the provider bundle that the packaged desktop runtime copies. */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("desktop runtime package build set", () => {
  it("rebuilds provider plugins before copying runtime node_modules", async () => {
    const source = await readFile(
      new URL("./desktop-build.mjs", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'const PLUGIN_OPENAI_PACKAGE_DIR = resolveWorkspacePluginDir("plugin-openai");',
    );
    expect(source).toContain(
      'ensureWorkspaceRuntimePackageBuilt(\n    "@elizaos/plugin-openai",\n    PLUGIN_OPENAI_PACKAGE_DIR,\n  );',
    );
    expect(source).toContain(
      'const PLUGIN_ELIZACLOUD_PACKAGE_DIR =\n  resolveWorkspacePluginDir("plugin-elizacloud");',
    );
    expect(source).toContain(
      'ensureWorkspaceRuntimePackageBuilt(\n    "@elizaos/plugin-elizacloud",\n    PLUGIN_ELIZACLOUD_PACKAGE_DIR,\n  );',
    );
  });
});
