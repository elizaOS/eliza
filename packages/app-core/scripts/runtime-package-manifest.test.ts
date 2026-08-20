/**
 * Exercises the packaged-runtime bundling policy that decides which discovered
 * npm packages ship inside the desktop/mobile runtime dist.
 *
 * The load-bearing case is scope. Only `@elizaos/plugin-*` is a
 * post-release-installable elizaOS runtime plugin. Third-party ecosystems use
 * the same `plugin-` prefix for ordinary hard dependencies, and dropping one of
 * those from the bundle ships its dependent without it — the packaged agent then
 * dies at import with `Cannot find module` and crash-loops with no UI.
 */
import { describe, expect, it } from "vitest";
import {
  isRuntimePluginPackage,
  shouldBundleDiscoveredPackage,
} from "./runtime-package-manifest";

const NO_PLUGINS_BUNDLED: ReadonlySet<string> = new Set<string>();

describe("isRuntimePluginPackage", () => {
  it("recognizes elizaOS runtime plugins", () => {
    expect(isRuntimePluginPackage("@elizaos/plugin-sql")).toBe(true);
    expect(isRuntimePluginPackage("@elizaos/plugin-local-inference")).toBe(
      true,
    );
    // Unscoped form used by local plugin projects.
    expect(isRuntimePluginPackage("plugin-my-project")).toBe(true);
  });

  it("does not claim third-party packages that merely use the plugin- prefix", () => {
    // Each of these is a hard dependency of a bundled package.
    expect(isRuntimePluginPackage("@octokit/plugin-request-log")).toBe(false);
    expect(isRuntimePluginPackage("@octokit/plugin-paginate-rest")).toBe(false);
    expect(
      isRuntimePluginPackage("@octokit/plugin-rest-endpoint-methods"),
    ).toBe(false);
    expect(isRuntimePluginPackage("@jimp/plugin-resize")).toBe(false);
    expect(isRuntimePluginPackage("@milkdown/plugin-history")).toBe(false);
    expect(isRuntimePluginPackage("@solana/plugin-core")).toBe(false);
  });

  it("ignores non-plugin and malformed names", () => {
    expect(isRuntimePluginPackage("")).toBe(false);
    expect(isRuntimePluginPackage("@elizaos/core")).toBe(false);
    expect(isRuntimePluginPackage("@elizaos")).toBe(false);
    expect(isRuntimePluginPackage("zod")).toBe(false);
    expect(isRuntimePluginPackage("plugin")).toBe(false);
  });
});

describe("shouldBundleDiscoveredPackage", () => {
  it("bundles third-party plugin-prefixed dependencies even when no plugin is bundled", () => {
    for (const name of [
      "@octokit/plugin-request-log",
      "@octokit/plugin-paginate-rest",
      "@octokit/plugin-rest-endpoint-methods",
      "@jimp/plugin-resize",
      "@milkdown/plugin-history",
    ]) {
      expect(shouldBundleDiscoveredPackage(name, NO_PLUGINS_BUNDLED)).toBe(
        true,
      );
    }
  });

  it("still gates elizaOS plugins on the always-bundled set", () => {
    expect(
      shouldBundleDiscoveredPackage(
        "@elizaos/plugin-notes",
        NO_PLUGINS_BUNDLED,
      ),
    ).toBe(false);
    expect(
      shouldBundleDiscoveredPackage(
        "@elizaos/plugin-notes",
        new Set(["@elizaos/plugin-notes"]),
      ),
    ).toBe(true);
  });

  it("always bundles the workflow plugin", () => {
    expect(
      shouldBundleDiscoveredPackage(
        "@elizaos/plugin-workflow",
        NO_PLUGINS_BUNDLED,
      ),
    ).toBe(true);
  });

  it("bundles ordinary dependencies", () => {
    expect(shouldBundleDiscoveredPackage("zod", NO_PLUGINS_BUNDLED)).toBe(true);
    expect(
      shouldBundleDiscoveredPackage("@octokit/rest", NO_PLUGINS_BUNDLED),
    ).toBe(true);
  });
});
