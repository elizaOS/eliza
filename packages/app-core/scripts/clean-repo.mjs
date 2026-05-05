#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Remove build outputs and tool caches so the next `bun run build` / dev run is cold.
 *
 * Usage:
 *   node scripts/clean-repo.mjs           # standard clean (dist, Vite, plugins, turbo, forge test artifacts, …)
 *   node scripts/clean-repo.mjs --deep    # also Electrobun/Electron local build outputs + generated preload
 *
 * Does not remove node_modules or global Bun/npm caches (set ELIZA_CLEAN_GLOBAL_TOOL_CACHE=1 to also run
 * `bun pm cache rm` — destructive to all Bun projects on the machine).
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPACITOR_PLUGIN_NAMES,
  NATIVE_PLUGINS_ROOT,
} from "../../app/scripts/capacitor-plugin-names.mjs";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = resolveRepoRootFromImportMeta(import.meta.url);
const deep = process.argv.includes("--deep");
const globalToolCache = process.env.ELIZA_CLEAN_GLOBAL_TOOL_CACHE === "1";

function rmPath(label, abs) {
  if (!existsSync(abs)) return;
  try {
    rmSync(abs, { recursive: true, force: true });
    console.log(`  removed ${label}`);
  } catch (err) {
    console.warn(
      `  skip ${label}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

function rmFile(label, abs) {
  if (!existsSync(abs)) return;
  try {
    rmSync(abs, { force: true });
    console.log(`  removed ${label}`);
  } catch (err) {
    console.warn(
      `  skip ${label}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Remove node_modules/.cache at root and under first-level workspace apps/packages we care about. */
function rmNodeModulesCaches() {
  const bases = [
    root,
    path.join(root, "packages", "app"),
    path.join(root, "apps", "homepage"),
    path.join(root, "packages", "ui"),
    path.join(root, "packages", "app-core"),
    path.join(root, "packages", "app-core", "platforms", "electrobun"),
  ];
  for (const base of bases) {
    const c = path.join(base, "node_modules", ".cache");
    rmPath(path.relative(root, c) || "node_modules/.cache", c);
  }
}

function rmPluginDists() {
  const pluginsRoot = NATIVE_PLUGINS_ROOT;
  if (!existsSync(pluginsRoot)) return;
  const relPlugins =
    path.relative(root, pluginsRoot) || "eliza/packages/native-plugins";
  for (const name of CAPACITOR_PLUGIN_NAMES) {
    rmPath(`${relPlugins}/${name}/dist`, path.join(pluginsRoot, name, "dist"));
  }
  // Any extra plugin dirs (not in canonical list) still get dist removed
  try {
    for (const ent of readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (CAPACITOR_PLUGIN_NAMES.includes(ent.name)) continue;
      const dist = path.join(pluginsRoot, ent.name, "dist");
      if (existsSync(dist)) {
        rmPath(`${relPlugins}/${ent.name}/dist`, dist);
      }
    }
  } catch {
    /* ignore */
  }
}

function main() {
  console.log(`[clean] repo root: ${root}${deep ? " (deep)" : ""}\n`);

  rmPath("dist", path.join(root, "dist"));
  rmPath("packages/app/dist", path.join(root, "packages", "app", "dist"));
  rmPath("packages/app/.vite", path.join(root, "packages", "app", ".vite"));
  rmPath(
    "packages/homepage/dist",
    path.join(root, "packages", "homepage", "dist"),
  );
  rmPath(
    "packages/homepage/.vite",
    path.join(root, "packages", "homepage", ".vite"),
  );

  rmPath(
    "eliza/packages/app-core/dist",
    path.join(root, "eliza", "packages", "app-core", "dist"),
  );

  rmPluginDists();

  rmPath(".turbo", path.join(root, ".turbo"));
  rmPath("coverage", path.join(root, "coverage"));

  rmNodeModulesCaches();

  rmPath(
    "packages/app/test-results",
    path.join(root, "packages", "app", "test-results"),
  );
  rmPath(
    "packages/app/playwright-report",
    path.join(root, "packages", "app", "playwright-report"),
  );

  if (deep) {
    rmPath(
      "packages/app-core/platforms/electrobun/build",
      path.join(
        root,
        "packages",
        "app-core",
        "platforms",
        "electrobun",
        "build",
      ),
    );
    rmPath(
      "packages/app-core/platforms/electrobun/artifacts",
      path.join(
        root,
        "packages",
        "app-core",
        "platforms",
        "electrobun",
        "artifacts",
      ),
    );
    rmFile(
      "packages/app-core/platforms/electrobun/src/preload.js (regenerate: bun run build:preload)",
      path.join(
        root,
        "packages",
        "app-core",
        "platforms",
        "electrobun",
        "src",
        "preload.js",
      ),
    );
    rmPath("dist-electron", path.join(root, "dist-electron"));
  }

  // Root-level tsbuildinfo if present (some toolchains emit here)
  const rootInfo = path.join(root, "tsconfig.tsbuildinfo");
  rmFile("tsconfig.tsbuildinfo", rootInfo);

  if (globalToolCache) {
    console.log("\n  ELIZA_CLEAN_GLOBAL_TOOL_CACHE=1 → bun pm cache rm");
    const r = spawnSync("bun", ["pm", "cache", "rm"], {
      stdio: "inherit",
      env: process.env,
    });
    if ((r.status ?? 1) !== 0) {
      console.warn(
        "  bun pm cache rm exited non-zero (ignored if bun unavailable)",
      );
    }
  }

  console.log("\n[clean] done. Next: bun run build  or  bun run dev");
  console.log(
    "  Tip: ELIZA_DEV_PLUGIN_BUILD=1 bun run dev  and/or  ELIZA_VITE_FORCE=1 bun run dev  after a deep clean.\n",
  );
}

main();
