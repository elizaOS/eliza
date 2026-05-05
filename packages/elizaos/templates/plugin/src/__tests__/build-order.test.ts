import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getViteOutDir } from "./vite-config-utils";

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(command, args, {
    cwd,
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
  });
}

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
    await run("bun", ["run", "build.ts"], rootDir);

    // Verify plugin build outputs exist
    const distFilesAfterPluginBuild = fs.readdirSync(distDir);
    expect(distFilesAfterPluginBuild.some((file) => file === "index.js")).toBe(true);
    // .d.ts files may not be generated if there are type errors

    // Then run vite build to generate frontend assets (should coexist with plugin outputs)
    await run("bunx", ["vite", "build"], rootDir);

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
