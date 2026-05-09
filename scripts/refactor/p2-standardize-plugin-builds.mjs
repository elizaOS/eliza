#!/usr/bin/env bun
// P2 — Standardize every plugin's build to emit .d.ts.
//
// Today: shared tsup config has dts:false; 28 plugins ship no declarations.
// Strategy: keep tsup for fast JS transpilation, add `tsc --emitDeclarationOnly`
// as a parallel step. Use a shared tsconfig.build.shared.json so per-plugin
// configs stay tiny.
//
// Changes this script makes:
//   1. Create plugins/tsconfig.build.shared.json (path-aliased to dist/.d.ts).
//   2. For each plugin in the "missing dts" group, edit package.json:
//        build:    "bun run build:js && bun run build:types"
//        build:js: <existing build command>
//        build:types: "tsc -p ../tsconfig.build.shared.json"
//   3. For plugins with their own tsup.config.ts and dts:false, set dts:true.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  REPO_ROOT,
  Stats,
  makeLogger,
  parseFlags,
  preflight,
  readJson,
  walkWorkspacePackages,
  writeFileIfChanged,
  writeJson,
} from "./lib/util.mjs";

const SHARED_TSCONFIG_PATH = "plugins/tsconfig.build.shared.json";
const SHARED_TSUP_CONFIG = "plugins/tsup.plugin-packages.shared.ts";

// Built shared tsconfig.build content. Path aliases point at dist/.d.ts so
// plugins typecheck against the published shape, not against source.
const SHARED_TSCONFIG_CONTENT = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": true,
    "noEmit": false,
    "paths": {
      "@elizaos/core": ["../../packages/core/dist/index.d.ts"],
      "@elizaos/core/*": ["../../packages/core/dist/*"],
      "@elizaos/shared": ["../../packages/shared/dist/index.d.ts"],
      "@elizaos/shared/*": ["../../packages/shared/dist/*"],
      "@elizaos/ui": ["../../packages/ui/dist/index.d.ts"],
      "@elizaos/ui/*": ["../../packages/ui/dist/*"],
      "@elizaos/app-core": ["../../packages/app-core/dist/index.d.ts"],
      "@elizaos/agent": ["../../packages/agent/dist/index.d.ts"],
      "@elizaos/cloud-sdk": ["../../cloud/packages/sdk/dist/index.d.ts"],
      "@elizaos/scenario-runner": ["../../packages/scenario-runner/dist/index.d.ts"]
    }
  }
}
`;

async function main() {
  const flags = parseFlags();
  const log = makeLogger(flags);
  preflight("p2-standardize-plugin-builds", flags, log);
  const stats = new Stats();

  log.section("1. Write shared plugin tsconfig.build");
  writeFileIfChanged(
    join(REPO_ROOT, SHARED_TSCONFIG_PATH),
    SHARED_TSCONFIG_CONTENT,
    flags,
    log,
  );

  log.section("2. Audit plugin builds and patch missing-dts ones");
  const pkgs = walkWorkspacePackages().filter((p) =>
    p.dir.includes("/plugins/") || p.dir.includes("/packages/native-plugins/"),
  );

  for (const { name, dir, packageJsonPath, pkg } of pkgs) {
    const buildCmd = pkg.scripts?.build ?? "";
    if (!buildCmd) continue;

    const usesSharedConfig =
      buildCmd.includes("tsup.plugin-packages.shared") ||
      pkg.scripts?.["build:js"]?.includes("tsup.plugin-packages.shared");
    const distHasDts = checkDistHasDts(dir);
    const ownTsupConfig = join(dir, "tsup.config.ts");
    const hasOwnTsup = existsSync(ownTsupConfig);

    if (distHasDts) {
      log.verbose(`${name}: already emits .d.ts (skip)`);
      continue;
    }

    if (usesSharedConfig) {
      patchPluginToAddTscStep(name, packageJsonPath, pkg, flags, log, stats);
      continue;
    }

    if (hasOwnTsup) {
      patchOwnTsupToEnableDts(ownTsupConfig, flags, log, stats);
      continue;
    }

    log.manual(`${name}: build command is "${buildCmd}" — needs manual review for dts emission`);
    stats.incr("manual review");
  }

  stats.print(log);
}

function checkDistHasDts(dir) {
  const dist = join(dir, "dist");
  if (!existsSync(dist) || !statSync(dist).isDirectory()) return false;
  // Sample: any .d.ts file under dist
  return hasDtsRecursive(dist, 3);
}

function hasDtsRecursive(dir, depth) {
  if (depth < 0) return false;
  let entries;
  try {
    const { readdirSync } = require("node:fs");
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".d.ts")) return true;
    if (entry.isDirectory() && hasDtsRecursive(join(dir, entry.name), depth - 1)) {
      return true;
    }
  }
  return false;
}

function patchPluginToAddTscStep(name, pkgPath, pkg, flags, log, stats) {
  pkg.scripts = pkg.scripts ?? {};
  const oldBuild = pkg.scripts.build;
  if (!oldBuild) return;
  writePluginTsconfig(pkgPath, flags, log, stats);
  if (
    pkg.scripts["build:js"] &&
    pkg.scripts["build:types"] &&
    pkg.scripts.build === "bun run build:js && bun run build:types" &&
    pkg.scripts["build:types"] === "tsc -p tsconfig.build.json"
  ) {
    log.verbose(`${name}: already split (skip)`);
    return;
  }
  if (!pkg.scripts["build:js"]) {
    pkg.scripts["build:js"] = oldBuild;
  }
  pkg.scripts["build:types"] = "tsc -p tsconfig.build.json";
  pkg.scripts.build = "bun run build:js && bun run build:types";
  log.info(`patch: ${name} → split build into js + types`);
  writeJson(pkgPath, pkg, flags, log);
  stats.incr("plugins patched (shared config + tsc step)");
}

function writePluginTsconfig(pkgPath, flags, log, stats) {
  const configPath = join(pkgPath, "..", "tsconfig.build.json");
  const content = `{
  "extends": "../tsconfig.build.shared.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "./src"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/__tests__/**"]
}
`;
  if (writeFileIfChanged(configPath, content, flags, log)) {
    stats.incr("plugin tsconfig.build files written");
  }
}

function patchOwnTsupToEnableDts(configPath, flags, log, stats) {
  const before = readFileSync(configPath, "utf8");
  let after = before;
  // Replace `dts: false` → `dts: true`
  if (/\bdts:\s*false\b/.test(before)) {
    after = before.replace(/\bdts:\s*false\b/g, "dts: true");
  }
  if (after === before) {
    log.verbose(`${relative(REPO_ROOT, configPath)}: no dts:false found (skip)`);
    return;
  }
  log.info(`patch: ${relative(REPO_ROOT, configPath)} → dts: true`);
  writeFileIfChanged(configPath, after, flags, log);
  stats.incr("own-tsup configs patched (dts: true)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
