import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createWorkspacePackageResolver } from "./workspace-packages.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

test("workspace resolver finds plugin packages not linked at root node_modules", () => {
  const resolvePackageDir = createWorkspacePackageResolver({
    repoRoot,
    nodeModulesRoots: [path.join(repoRoot, ".missing-node-modules")],
  });

  assert.equal(
    resolvePackageDir("@elizaos/plugin-vision"),
    path.join(repoRoot, "plugins", "plugin-vision"),
  );
  assert.equal(
    resolvePackageDir("@elizaos/plugin-birdclaw"),
    path.join(repoRoot, "plugins", "plugin-birdclaw"),
  );
});

test("workspace resolver finds nested cloud packages", () => {
  const resolvePackageDir = createWorkspacePackageResolver({
    repoRoot,
    nodeModulesRoots: [path.join(repoRoot, ".missing-node-modules")],
  });

  assert.equal(
    resolvePackageDir("@elizaos/cloud-routing"),
    path.join(repoRoot, "packages", "cloud", "routing"),
  );
  assert.equal(
    resolvePackageDir("@elizaos/cloud-sdk"),
    path.join(repoRoot, "packages", "cloud", "sdk"),
  );
});

test("workspace resolver returns package roots used for subpath fallbacks", () => {
  const resolvePackageDir = createWorkspacePackageResolver({
    repoRoot,
    nodeModulesRoots: [path.join(repoRoot, ".missing-node-modules")],
  });

  assert.equal(
    resolvePackageDir("@elizaos/plugin-wallet"),
    path.join(repoRoot, "plugins", "plugin-wallet"),
  );
});
