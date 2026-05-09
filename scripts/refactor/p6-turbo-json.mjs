#!/usr/bin/env bun
// P6 — Refresh turbo.json.
//
// After P3 flips main→dist, every workspace package needs its #build task
// covered. Most packages inherit the generic `build` task with `^build` deps,
// but explicit entries help for packages that have non-default deps or
// require specific ordering.
//
// What this script does:
//   1. Add a `typecheck:dist` task entry that depends on every package's #build.
//   2. Ensure every package referenced by an existing `#build` task still
//      exists in the workspace (re-run the validation from phase 1).
//   3. Print suggested additions for packages that produce a dist but have no
//      explicit turbo entry — does NOT auto-add (high false-positive risk).

import { join } from "node:path";
import {
  REPO_ROOT,
  Stats,
  makeLogger,
  parseFlags,
  preflight,
  readJson,
  walkWorkspacePackages,
  writeJson,
} from "./lib/util.mjs";

async function main() {
  const flags = parseFlags();
  const log = makeLogger(flags);
  preflight("p6-turbo-json", flags, log);
  const stats = new Stats();

  const turboPath = join(REPO_ROOT, "turbo.json");
  const turbo = readJson(turboPath);
  const before = JSON.stringify(turbo);

  log.section("1. Add typecheck:dist task");
  if (!turbo.tasks["typecheck:dist"]) {
    turbo.tasks["typecheck:dist"] = {
      dependsOn: ["^build"],
      outputs: [],
    };
    stats.incr("tasks added", 1);
    log.info("add task: typecheck:dist");
  } else {
    log.verbose("typecheck:dist already present");
  }

  log.section("2. Validate all referenced packages exist");
  const allPkgNames = new Set(
    walkWorkspacePackages().map((p) => p.name).filter(Boolean),
  );
  const referenced = new Set();
  for (const taskKey of Object.keys(turbo.tasks)) {
    if (!taskKey.includes("#")) continue;
    const pkgName = taskKey.split("#")[0];
    referenced.add(pkgName);
  }
  // Also collect from dependsOn arrays.
  for (const task of Object.values(turbo.tasks)) {
    for (const dep of task.dependsOn ?? []) {
      if (typeof dep !== "string") continue;
      if (dep.startsWith("^") || !dep.includes("#")) continue;
      referenced.add(dep.split("#")[0]);
    }
  }

  const missing = [...referenced].filter((p) => !allPkgNames.has(p));
  if (missing.length > 0) {
    for (const m of missing) log.warn(`turbo.json references missing package: ${m}`);
    stats.incr("missing package refs", missing.length);
  } else {
    log.info("all turbo.json package refs valid");
  }

  log.section("3. Suggest explicit entries for missing-but-built packages");
  const explicitlyConfigured = new Set();
  for (const taskKey of Object.keys(turbo.tasks)) {
    if (!taskKey.endsWith("#build")) continue;
    explicitlyConfigured.add(taskKey.split("#")[0]);
  }
  let suggestions = 0;
  for (const { name, pkg } of walkWorkspacePackages()) {
    if (!pkg.scripts?.build) continue;
    if (explicitlyConfigured.has(name)) continue;
    if (!name.startsWith("@elizaos/") && !name.startsWith("@babylon/")) continue;
    // Suggest: would benefit from explicit entry to declare deps order.
    log.verbose(`(suggest) "${name}#build" could declare its core/shared deps`);
    suggestions++;
  }
  log.note(
    `${suggestions} packages have a build script but no explicit turbo entry. ` +
      "Most rely on the generic `build` task with `^build` dep, which is fine. " +
      "Add explicit entries only if you need non-default dependencies.",
  );

  log.section("4. Save changes");
  if (JSON.stringify(turbo) !== before) {
    writeJson(turboPath, turbo, flags, log);
    stats.incr("turbo.json updated", 1);
  } else {
    log.verbose("no changes to turbo.json");
  }

  stats.print(log);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
