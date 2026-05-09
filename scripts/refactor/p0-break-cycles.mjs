#!/usr/bin/env bun
// P0 — Break circular dependencies.
//
// 1. Move shared types/utils from @elizaos/agent → @elizaos/cloud-sdk and @elizaos/shared
//    so plugin-elizacloud no longer imports from agent.
// 2. Add a cloud-route registry to agent so it dispatches without importing plugin-elizacloud.
// 3. Drop unused workspace deps (app-lifeops, app-elizamaker, etc.) from agent's package.json.
//
// Files this script DOES NOT rewrite by itself (logged as MANUAL):
//   - The route-registry integration in packages/agent/src/api/server*.ts
//     (because the wiring is structural; mechanical sed will leave dangling refs).
//   - Anything where the source file isn't where the plan expects.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  Stats,
  makeLogger,
  moveFile,
  parseFlags,
  preflight,
  readJson,
  rewriteImports,
  walkSourceFiles,
  writeFileIfChanged,
  writeJson,
} from "./lib/util.mjs";

// ────────────────────────────────────────────────────────────────────────────
// Migration table: things to extract from agent into other packages.
// Each row: source path under packages/agent/src, destination package, dest subpath.
// The script verifies the source exists, moves it, and rewrites imports.

const SYMBOL_MOVES = [
  // Config types & loaders → cloud-sdk
  {
    from: "packages/agent/src/config/eliza.ts",
    to: "packages/cloud-sdk/src/config/eliza.ts",
    importMap: {
      "@elizaos/agent/config/eliza": "@elizaos/cloud-sdk/config/eliza",
      "@elizaos/agent/src/config/eliza": "@elizaos/cloud-sdk/config/eliza",
    },
  },
  // Route helpers → shared
  {
    from: "packages/agent/src/api/route-helpers.ts",
    to: "packages/shared/src/api/route-helpers.ts",
    importMap: {
      "@elizaos/agent/api/route-helpers": "@elizaos/shared/api/route-helpers",
    },
  },
  {
    from: "packages/agent/src/api/http-helpers.ts",
    to: "packages/shared/src/api/http-helpers.ts",
    importMap: {
      "@elizaos/agent/api/http-helpers": "@elizaos/shared/api/http-helpers",
    },
  },
  // Telemetry helper → shared
  {
    from: "packages/agent/src/diagnostics/telemetry.ts",
    to: "packages/shared/src/diagnostics/telemetry.ts",
    importMap: {
      "@elizaos/agent/diagnostics/telemetry": "@elizaos/shared/diagnostics/telemetry",
    },
  },
  // State-dir resolver → shared
  {
    from: "packages/agent/src/runtime/state-dir.ts",
    to: "packages/shared/src/runtime/state-dir.ts",
    importMap: {
      "@elizaos/agent/runtime/state-dir": "@elizaos/shared/runtime/state-dir",
    },
  },
];

// Workspace deps to drop from packages/agent/package.json IF agent/src/** does
// not actually import them. The pre-flight check counts imports; we only drop
// when the count is zero.
const CANDIDATE_DROPPED_DEPS = [
  "@elizaos/app-lifeops",
  "@elizaos/app-elizamaker",
  "@elizaos/app-task-coordinator",
  "@elizaos/app-training",
];

// New file: cloud-route registry. Lets agent dispatch to plugin-elizacloud
// without importing it.
const CLOUD_REGISTRY_PATH = "packages/agent/src/api/cloud-route-registry.ts";
const CLOUD_REGISTRY_SOURCE = `/**
 * Cloud route registry — inverts the agent ↔ plugin-elizacloud dependency.
 *
 * plugin-elizacloud (or any other cloud provider) calls registerCloudRoutes()
 * during plugin init. The agent's API server reads from this registry instead
 * of importing plugin-elizacloud directly.
 *
 * This breaks the cycle: agent no longer needs plugin-elizacloud as a
 * compile-time dependency; the registry is filled at runtime.
 */

export interface CloudRouteHandlers {
  handleCloudBillingRoute?: (...args: unknown[]) => unknown;
  handleCloudCompatRoute?: (...args: unknown[]) => unknown;
  handleCloudRelayRoute?: (...args: unknown[]) => unknown;
  handleCloudStatusRoutes?: (...args: unknown[]) => unknown;
  handleCloudFeaturesRoute?: (...args: unknown[]) => unknown;
  isCloudProvisionedContainer?: () => boolean;
  // extend as more cloud route handlers are migrated
}

let registered: CloudRouteHandlers = {};

export function registerCloudRoutes(handlers: CloudRouteHandlers): void {
  registered = { ...registered, ...handlers };
}

export function getCloudRoutes(): CloudRouteHandlers {
  return registered;
}

export function clearCloudRoutes(): void {
  registered = {};
}
`;

// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseFlags();
  const log = makeLogger(flags);
  preflight("p0-break-cycles", flags, log);
  const stats = new Stats();

  // 1) Move symbols out of agent
  log.section("1. Move shared symbols out of @elizaos/agent");
  const importRewrites = {};
  for (const move of SYMBOL_MOVES) {
    const fromAbs = join(REPO_ROOT, move.from);
    const toAbs = join(REPO_ROOT, move.to);
    if (moveFile(fromAbs, toAbs, flags, log)) {
      stats.incr("files moved");
      Object.assign(importRewrites, move.importMap);
    } else {
      log.manual(`File not at expected path: ${move.from}`);
      log.manual(`  Plan says: extract this file's symbols and migrate to ${move.to}`);
      stats.incr("manual moves");
    }
  }

  // 2) Rewrite imports across the entire repo
  if (Object.keys(importRewrites).length > 0) {
    log.section("2. Rewrite imports referencing moved symbols");
    rewriteImportsAcrossRepo(importRewrites, flags, log, stats);
  } else {
    log.note("No symbols moved; skipping import rewrite.");
  }

  // 3) Add cloud-route registry to agent
  log.section("3. Add cloud-route registry to @elizaos/agent");
  const registryAbs = join(REPO_ROOT, CLOUD_REGISTRY_PATH);
  writeFileIfChanged(registryAbs, CLOUD_REGISTRY_SOURCE, flags, log);
  stats.incr("registry files created");
  log.manual(
    `Wire up agent/src/api/server*.ts to read from getCloudRoutes() instead of importing handleCloudBillingRoute etc. directly from @elizaos/plugin-elizacloud.`,
  );
  log.manual(
    `Wire up plugin-elizacloud's plugin init to call registerCloudRoutes({ handleCloudBillingRoute, ... }).`,
  );

  // 4) Drop unused workspace deps from agent's package.json
  log.section("4. Drop unused workspace deps from @elizaos/agent");
  dropUnusedDeps(flags, log, stats);

  // 5) Re-export from @elizaos/cloud-sdk and @elizaos/shared barrels
  log.section("5. Update barrel exports");
  updateBarrel(
    "packages/cloud-sdk/src/index.ts",
    [
      ["./config/eliza", "packages/cloud-sdk/src/config/eliza.ts"],
    ],
    flags,
    log,
    stats,
  );
  updateBarrel(
    "packages/shared/src/index.ts",
    [
      ["./api/route-helpers", "packages/shared/src/api/route-helpers.ts"],
      ["./api/http-helpers", "packages/shared/src/api/http-helpers.ts"],
      ["./diagnostics/telemetry", "packages/shared/src/diagnostics/telemetry.ts"],
      ["./runtime/state-dir", "packages/shared/src/runtime/state-dir.ts"],
    ],
    flags,
    log,
    stats,
  );

  stats.print(log);
  if (!flags.apply) log.note("Dry-run complete. Re-run with --apply to mutate.");
}

function rewriteImportsAcrossRepo(map, flags, log, stats) {
  const files = walkSourceFiles(REPO_ROOT, (path) => {
    return !path.includes(`${REPO_ROOT}/scripts/refactor/`);
  });
  let changed = 0;
  let totalImports = 0;
  for (const file of files) {
    const before = readFileSync(file, "utf8");
    const { source, changes } = rewriteImports(before, (spec) => map[spec]);
    if (changes > 0) {
      writeFileIfChanged(file, source, flags, log);
      changed++;
      totalImports += changes;
    }
  }
  stats.incr("files with rewritten imports", changed);
  stats.incr("import statements rewritten", totalImports);
}

function dropUnusedDeps(flags, log, stats) {
  const pkgPath = join(REPO_ROOT, "packages/agent/package.json");
  if (!existsSync(pkgPath)) {
    log.warn("packages/agent/package.json missing");
    return;
  }
  const pkg = readJson(pkgPath);
  const agentSrcRoot = join(REPO_ROOT, "packages/agent/src");
  const agentFiles = walkSourceFiles(agentSrcRoot);
  const concatenatedSource = agentFiles
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  let dropped = 0;
  for (const dep of CANDIDATE_DROPPED_DEPS) {
    const importPattern = new RegExp(
      `from\\s+["']${dep.replace(/[/\\-]/g, "\\$&")}(?:/[^"']*)?["']`,
      "g",
    );
    const dynPattern = new RegExp(
      `import\\s*\\(\\s*["']${dep.replace(/[/\\-]/g, "\\$&")}(?:/[^"']*)?["']`,
      "g",
    );
    const isImported =
      importPattern.test(concatenatedSource) || dynPattern.test(concatenatedSource);
    if (isImported) {
      log.note(`keep dep ${dep} (imported by agent/src)`);
      continue;
    }
    if (pkg.dependencies?.[dep]) {
      log.info(`drop dep: ${dep}`);
      delete pkg.dependencies[dep];
      dropped++;
    }
  }
  if (dropped > 0) {
    writeJson(pkgPath, pkg, flags, log);
    stats.incr("unused deps dropped", dropped);
  }
}

function updateBarrel(relPath, additions, flags, log, stats) {
  const abs = join(REPO_ROOT, relPath);
  let source = "";
  if (existsSync(abs)) {
    source = readFileSync(abs, "utf8");
  } else {
    log.manual(`barrel ${relPath} doesn't exist; skipping additions`);
    return;
  }
  let appended = "";
  for (const [exportPath, sourceFile] of additions) {
    if (!existsSync(join(REPO_ROOT, sourceFile))) continue;
    if (source.includes(`from "${exportPath}"`)) continue;
    appended += `export * from "${exportPath}";\n`;
  }
  if (appended) {
    const newSource = source.endsWith("\n") ? source + appended : source + "\n" + appended;
    writeFileIfChanged(abs, newSource, flags, log);
    stats.incr("barrel re-exports added", additions.length);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
