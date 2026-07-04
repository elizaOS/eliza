#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listWorkspaceDirs } from "./lib/workspaces.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const outPath = path.join(repoRoot, "tsconfig.dist-paths.json");
const checkOnly = process.argv.includes("--check");

const explicitAliases = new Map([
  ["@elizaos/agent/*", ["./packages/agent/dist/*.d.ts"]],
  [
    "@elizaos/benchmark-framework",
    ["./packages/benchmarks/framework/typescript/dist/index.d.ts"],
  ],
  [
    "@elizaos/configbench",
    ["./packages/benchmarks/configbench/dist/index.d.ts"],
  ],
  ["@elizaos/plugin-facewear/*", ["./plugins/plugin-facewear/dist/*.d.ts"]],
  [
    "@elizaos/plugin-local-inference/routes",
    ["./plugins/plugin-local-inference/src/routes/index.ts"],
  ],
  [
    "@elizaos/plugin-local-inference/runtime",
    ["./plugins/plugin-local-inference/src/runtime/index.ts"],
  ],
  [
    "@elizaos/plugin-local-inference/services",
    ["./plugins/plugin-local-inference/src/services/index.ts"],
  ],
  ["@elizaos/plugin-music-library", ["./plugins/plugin-music/dist/index.d.ts"]],
  ["@elizaos/plugin-music-player", ["./plugins/plugin-music/dist/index.d.ts"]],
  ["@elizaos/plugin-xai/*", ["./plugins/plugin-xai/*"]],
  ["@elizaos/prompts", ["./packages/prompts/dist/index.d.ts"]],
  [
    "@elizaos/shared/local-inference",
    ["./packages/shared/src/local-inference/index.ts"],
  ],
]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

// Absolute package.json paths of every workspace member, sorted. Discovery is
// the shared seam (root `workspaces` globs, negation applied, members carry a
// package.json).
function workspacePackageManifests() {
  return listWorkspaceDirs({ repoRoot })
    .map((relDir) => path.join(repoRoot, relDir, "package.json"))
    .sort((left, right) => left.localeCompare(right));
}

function findTypes(exportValue) {
  if (!exportValue || typeof exportValue === "string") return null;
  if (Array.isArray(exportValue)) {
    for (const item of exportValue) {
      const types = findTypes(item);
      if (types) return types;
    }
    return null;
  }
  if (typeof exportValue !== "object") return null;
  if (typeof exportValue.types === "string") return exportValue.types;

  for (const condition of [
    "import",
    "node",
    "bun",
    "browser",
    "default",
    "require",
  ]) {
    const types = findTypes(exportValue[condition]);
    if (types) return types;
  }

  const sourceTypes = findTypes(exportValue["eliza-source"]);
  if (sourceTypes) return sourceTypes;

  for (const value of Object.values(exportValue)) {
    const types = findTypes(value);
    if (types) return types;
  }
  return null;
}

function aliasTarget(packageDir, typesPath) {
  const relDir = toPosix(path.relative(repoRoot, packageDir));
  const cleanTypesPath = typesPath.replace(/^\.\//, "");
  return `./${path.posix.join(relDir, cleanTypesPath)}`;
}

function packageAliases(manifestPath) {
  const packageDir = path.dirname(manifestPath);

  const pkg = readJson(manifestPath);
  if (!pkg.name) return [];

  const aliases = [];
  const exportsMap =
    pkg.exports &&
    typeof pkg.exports === "object" &&
    !Array.isArray(pkg.exports)
      ? pkg.exports
      : {};
  const mainTypes = findTypes(exportsMap["."]) ?? pkg.types ?? pkg.typings;
  if (mainTypes) {
    aliases.push([pkg.name, [aliasTarget(packageDir, mainTypes)]]);
  }

  return aliases;
}

const paths = new Map();
for (const manifestPath of workspacePackageManifests()) {
  for (const [alias, targets] of packageAliases(manifestPath)) {
    paths.set(alias, targets);
  }
}
for (const [alias, targets] of explicitAliases) {
  paths.set(alias, targets);
}

const sortedPaths = Object.fromEntries(
  [...paths.entries()].sort(([left], [right]) => left.localeCompare(right)),
);
const config = {
  $schema: "https://json.schemastore.org/tsconfig",
  extends: "./tsconfig.json",
  compilerOptions: {
    composite: false,
    declaration: false,
    declarationMap: false,
    paths: sortedPaths,
  },
  include: [
    "packages/*/src/**/*",
    "plugins/plugin-native-*/src/**/*",
    "plugins/*/*.ts",
    "plugins/*/src/**/*",
    "plugins/*/typescript/**/*.ts",
    "packages/cloud-*/src/**/*",
    "packages/cloud/services/*/src/**/*",
  ],
  exclude: [
    "**/node_modules/**",
    "**/dist/**",
    "**/*.stories.ts",
    "**/*.stories.tsx",
  ],
};

const nextBody = `${JSON.stringify(config, null, 2)}\n`;

if (checkOnly) {
  const currentBody = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (currentBody !== nextBody) {
    console.error(
      "[generate-dist-paths-config] tsconfig.dist-paths.json is stale; run `node packages/scripts/generate-dist-paths-config.mjs`",
    );
    process.exit(1);
  }
  console.log(
    `[generate-dist-paths-config] ✓ ${Object.keys(sortedPaths).length} path aliases are current`,
  );
} else {
  writeFileSync(outPath, nextBody);
  console.log(
    `[generate-dist-paths-config] wrote ${Object.keys(sortedPaths).length} path aliases`,
  );
}
