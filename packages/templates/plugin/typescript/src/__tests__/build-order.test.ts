import fs from "node:fs";
import path from "node:path";
import { $ } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getViteOutDir } from "./vite-config-utils";

describe("Build Order Integration Test", () => {
  const rootDir = path.resolve(__dirname, "../..");
  const distDir = path.join(rootDir, "dist");
  let _viteBuildDir: string;
  const _tsupBuildMarker = path.join(distDir, "index.js"); // TSup creates this

  beforeAll(async () => {
    // Get the actual vite build directory from config
    const viteOutDirRelative = await getViteOutDir(rootDir);
    _viteBuildDir = path.join(rootDir, viteOutDirRelative);

    // Clean dist directory before test
    if (fs.existsSync(distDir)) {
      await fs.promises.rm(distDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    // Clean up after test
    if (fs.existsSync(distDir)) {
      await fs.promises.rm(distDir, { recursive: true, force: true });
    }
  });

  it("should ensure vite build outputs persist after tsup build", async () => {
    // First run the plugin build process (this clears dist)
    await $`cd ${rootDir} && bun run build.ts`.quiet();

    // Verify plugin build outputs exist
    const distFilesAfterPluginBuild = fs.readdirSync(distDir);
    expect(distFilesAfterPluginBuild.some((file) => file === "index.js")).toBe(true);
    // .d.ts files may not be generated if there are type errors

    // Then run vite build to generate frontend assets (should coexist with plugin outputs)
    await $`cd ${rootDir} && bunx vite build`.quiet();

    // Verify both builds coexist
    const distFiles = fs.readdirSync(distDir);

    // Should have vite outputs (HTML files)
    expect(distFiles.some((file) => file.endsWith(".html"))).toBe(true);

    // Should have vite manifest
    const viteManifestPath = path.join(distDir, ".vite", "manifest.json");
    expect(fs.existsSync(viteManifestPath)).toBe(true);

    // Should have vite assets directory
    expect(distFiles.includes("assets")).toBe(true);

    // Should still have plugin build outputs (JS file)
    expect(distFiles.some((file) => file === "index.js")).toBe(true);
  }, 30000); // 30 second timeout for build process
});
