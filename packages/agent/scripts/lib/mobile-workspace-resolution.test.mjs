/**
 * Contract tests for mobile bundle workspace source fallback resolution.
 *
 * These cases mirror the packages that blocked fresh iOS simulator builds in
 * #13408 when the package existed in the checkout but Bun.build did not resolve
 * it through the isolated node_modules layout.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePackageRoot } from "./mobile-workspace-resolution.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

describe("mobile workspace package resolution", () => {
  it.each([
    ["@elizaos/plugin-birdclaw", "plugins/plugin-birdclaw"],
    ["@elizaos/plugin-background-runner", "plugins/plugin-background-runner"],
    ["@elizaos/plugin-commands", "plugins/plugin-commands"],
    ["@elizaos/plugin-vision", "plugins/plugin-vision"],
    ["@elizaos/plugin-wallet", "plugins/plugin-wallet"],
    ["@elizaos/cloud-routing", "packages/cloud/routing"],
    ["@elizaos/cloud-sdk", "packages/cloud/sdk"],
  ])("finds %s in the workspace tree", (packageName, relativePath) => {
    expect(resolveWorkspacePackageRoot(repoRoot, packageName)).toBe(
      path.join(repoRoot, relativePath),
    );
  });

  it("returns null for packages outside the workspace", () => {
    expect(
      resolveWorkspacePackageRoot(repoRoot, "@elizaos/not-a-package"),
    ).toBe(null);
  });
});
