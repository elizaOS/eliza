/**
 * Checks the release-plugin policy: runtime support packages ship in the bundle
 * without being counted as bundled registry plugins, and
 * `classifyRegistryPluginRelease` reports bundled vs post-release correctly.
 * Deterministic — drives the pure policy functions over in-memory dependency lists.
 */
import { describe, expect, it } from "vitest";

import {
  BASELINE_BUNDLED_RUNTIME_PACKAGES,
  classifyRegistryPluginRelease,
  getBundledRuntimePackages,
  getBundledRuntimePluginIds,
} from "./release-plugin-policy.ts";

describe("release plugin policy", () => {
  it("ships runtime support packages without marking them as bundled registry plugins", () => {
    const availableDependencies = [
      "@elizaos/plugin-remote-manifest",
      "@elizaos/plugin-worker-runtime",
      "@elizaos/plugin-app-manager",
      "@elizaos/plugin-imessage",
      "@elizaos/plugin-streaming",
      "@elizaos/ui",
      "@elizaos/app-model-tester",
      "@elizaos/plugin-training",
      "@elizaos/plugin-openai",
    ];

    expect(BASELINE_BUNDLED_RUNTIME_PACKAGES).toEqual(
      expect.arrayContaining([
        "@elizaos/plugin-remote-manifest",
        "@elizaos/plugin-worker-runtime",
      ]),
    );
    expect(getBundledRuntimePackages(availableDependencies)).toEqual(
      expect.arrayContaining([
        "@elizaos/plugin-remote-manifest",
        "@elizaos/plugin-worker-runtime",
        "@elizaos/plugin-app-manager",
        "@elizaos/plugin-imessage",
        "@elizaos/plugin-streaming",
        "@elizaos/ui",
        "@elizaos/app-model-tester",
        "@elizaos/plugin-training",
        "@elizaos/plugin-openai",
      ]),
    );

    const bundledPluginIds = new Set(
      getBundledRuntimePluginIds(availableDependencies),
    );

    expect([...bundledPluginIds]).toEqual(["openai"]);
    expect(
      classifyRegistryPluginRelease({
        packageName: "@elizaos/plugin-openai",
        bundledPluginIds,
      }).releaseAvailability,
    ).toBe("bundled");
    expect(
      classifyRegistryPluginRelease({
        packageName: "@elizaos/plugin-remote-manifest",
        bundledPluginIds: new Set(["remote-manifest"]),
      }).releaseAvailability,
    ).toBe("post-release");
  });
});
