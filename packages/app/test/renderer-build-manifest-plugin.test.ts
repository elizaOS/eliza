/**
 * Vite close-bundle coverage for the renderer identity written into native
 * artifacts. Uses a real temporary renderer directory and manifest writer.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedConfig } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rendererBuildManifestPlugin } from "../vite/renderer-build-manifest-plugin";

const envKeys = [
  "GIT_COMMIT",
  "GIT_SHA",
  "ELIZA_BUILD_VARIANT",
  "ELIZA_CAPACITOR_BUILD_TARGET",
  "VITE_ELIZA_IOS_RUNTIME_MODE",
  "VITE_ELIZA_ANDROID_RUNTIME_MODE",
  "ELIZA_RUNTIME_MODE",
  "VITE_ELIZA_CLOUD_BASE",
  "VITE_CLOUD_BASE",
] as const;

const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function rendererDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "eliza-renderer-plugin-"));
  temporaryDirectories.push(directory);
  mkdirSync(path.join(directory, "assets"));
  writeFileSync(path.join(directory, "index.html"), "<main>Eliza</main>");
  writeFileSync(path.join(directory, "assets", "app-abc.js"), "export{};");
  return directory;
}

describe("rendererBuildManifestPlugin", () => {
  it("stamps the selected Cloud origin into the native renderer identity", () => {
    const outDir = rendererDirectory();
    process.env.GIT_COMMIT = "commit-under-test";
    process.env.ELIZA_BUILD_VARIANT = "store";
    process.env.ELIZA_CAPACITOR_BUILD_TARGET = "ios";
    process.env.VITE_ELIZA_IOS_RUNTIME_MODE = "cloud";
    process.env.VITE_ELIZA_CLOUD_BASE = "https://staging.elizacloud.ai";
    const plugin = rendererBuildManifestPlugin();
    const info = vi.fn();

    plugin.configResolved?.({
      build: { outDir },
    } as ResolvedConfig);
    plugin.closeBundle?.call({ info } as never);

    const manifest = JSON.parse(
      readFileSync(path.join(outDir, "eliza-renderer-build.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      commit: "commit-under-test",
      variant: "store",
      capacitorTarget: "ios",
      runtimeMode: "cloud",
      cloudBase: "https://staging.elizacloud.ai",
      assetCount: 1,
    });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("[renderer-build-manifest] wrote"),
    );
  });

  it("skips non-renderer secondary bundles without hiding real failures", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "eliza-non-renderer-"));
    temporaryDirectories.push(outDir);
    const plugin = rendererBuildManifestPlugin();
    plugin.configResolved?.({ build: { outDir } } as ResolvedConfig);

    expect(() =>
      plugin.closeBundle?.call({ info: vi.fn() } as never),
    ).not.toThrow();
  });
});
