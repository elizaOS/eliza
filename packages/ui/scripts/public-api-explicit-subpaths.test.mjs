import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  collectExplicitSubpathExports,
  diffExplicitSubpathExports,
} from "./public-api-explicit-subpaths.mjs";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("collects exact non-root exports and preserves their target maps", () => {
  const collected = collectExplicitSubpathExports(
    {
      ".": "./dist/index.js",
      "./package.json": "./package.json",
      "./styles/*.css": "./dist/styles/*.css",
      "./app-shell-registry": {
        types: "./dist/app-shell-registry.d.ts",
        import: "./dist/app-shell-registry.js",
        default: "./dist/app-shell-registry.js",
      },
      "./cloud-ui/index.css": "./dist/cloud-ui/index.css",
    },
    "@elizaos/ui",
  );

  assert.deepEqual(collected, [
    {
      specifier: "@elizaos/ui/app-shell-registry",
      target: {
        types: "./dist/app-shell-registry.d.ts",
        import: "./dist/app-shell-registry.js",
        default: "./dist/app-shell-registry.js",
      },
    },
    {
      specifier: "@elizaos/ui/cloud-ui/index.css",
      target: "./dist/cloud-ui/index.css",
    },
    {
      specifier: "@elizaos/ui/package.json",
      target: "./package.json",
    },
  ]);
});

test("reports added, removed, and retargeted exact subpaths", () => {
  const previous = [
    { specifier: "@elizaos/ui/App", target: "./dist/App.js" },
    {
      specifier: "@elizaos/ui/app-shell-registry",
      target: "./dist/app-shell-registry.js",
    },
  ];
  const current = [
    { specifier: "@elizaos/ui/App", target: "./dist/App.v2.js" },
    { specifier: "@elizaos/ui/auth-status", target: "./dist/auth-status.js" },
  ];

  assert.deepEqual(diffExplicitSubpathExports(previous, current), {
    added: [current[1]],
    removed: [previous[1]],
    retargeted: [current[0]],
  });
});

test("detects removal and retargeting in the real UI manifest", () => {
  const original = collectExplicitSubpathExports(
    packageJson.exports,
    packageJson.name,
  );
  assert.ok(
    original.some(
      (entry) => entry.specifier === "@elizaos/ui/app-shell-registry",
    ),
  );

  const withoutRegistry = structuredClone(packageJson.exports);
  delete withoutRegistry["./app-shell-registry"];
  const removal = diffExplicitSubpathExports(
    original,
    collectExplicitSubpathExports(withoutRegistry, packageJson.name),
  );
  assert.deepEqual(
    removal.removed.map((entry) => entry.specifier),
    ["@elizaos/ui/app-shell-registry"],
  );

  const withRetargetedAuth = structuredClone(packageJson.exports);
  withRetargetedAuth["./auth-status"].import = "./dist/auth-status-v2.js";
  const retarget = diffExplicitSubpathExports(
    original,
    collectExplicitSubpathExports(withRetargetedAuth, packageJson.name),
  );
  assert.deepEqual(
    retarget.retargeted.map((entry) => entry.specifier),
    ["@elizaos/ui/auth-status"],
  );
});
