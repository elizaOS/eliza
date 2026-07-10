#!/usr/bin/env node
/**
 * Builds every plugin's dynamic view bundle and refuses to report success on a
 * build that emitted nothing. Each plugin with a `vite.config.views.ts` must
 * produce `dist/views/bundle.js`; a downstream audit trusts that artifact to
 * prove the production view, so a missing or stale bundle here is a hard failure
 * (issue #15791), never a silent no-op. The orchestration only runs when this
 * file is executed as a script — the helpers are importable for tests.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/** Absolute path to the bundle a plugin's view config is required to emit. */
export function expectedBundlePath(configPath) {
  return path.join(path.dirname(configPath), "dist", "views", "bundle.js");
}

/**
 * A build that finished with no configured bundle missing is the only success.
 * Returns a non-empty error message when any expected bundle is absent so the
 * caller fails loudly instead of validating a stale or never-produced artifact.
 */
export function missingBundleReport(missingBundles) {
  if (missingBundles.length === 0) return null;
  const lines = missingBundles.map(
    (bundle) =>
      `  ✗ ${bundle.name}: expected ${bundle.relativeBundle} (declared by ${bundle.relativeConfig})`,
  );
  return (
    `[build-views] ${missingBundles.length} configured view bundle(s) missing after build:\n` +
    `${lines.join("\n")}\n` +
    "[build-views] Each plugin with vite.config.views.ts must emit " +
    "dist/views/bundle.js; a build that produces none is a failure, not a no-op."
  );
}

async function findViewConfigs(filter) {
  const pluginsDir = path.join(repoRoot, "plugins");
  const entries = await readdir(pluginsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pluginsDir, entry.name, "vite.config.views.ts"))
    .filter((configPath) => existsSync(configPath))
    .filter((configPath) => {
      if (!filter) return true;
      const pluginName = path.basename(path.dirname(configPath));
      return pluginName.includes(filter) || `@elizaos/${pluginName}` === filter;
    })
    .sort();
}

async function buildView(configPath) {
  const cwd = path.dirname(configPath);
  const label = path.relative(repoRoot, cwd);
  // Delete the previous bundle first so a build that silently emits nothing
  // (misconfigured entry, skipped compile) cannot pass on a stale artifact —
  // the post-build guard would otherwise validate last run's output.
  await rm(expectedBundlePath(configPath), { force: true });
  const { status, output } = await runBun(["run", "build:views"], cwd);
  return { label, status: status ?? 1, output };
}

function runBun(buildArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", buildArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code, output: Buffer.concat(chunks) });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const filterArg = args.find(
    (arg) => arg === "--filter" || arg.startsWith("--filter="),
  );
  const filter =
    filterArg === "--filter"
      ? args[args.indexOf(filterArg) + 1]
      : filterArg?.slice("--filter=".length);

  const configs = await findViewConfigs(filter);
  if (configs.length === 0) {
    console.log("[build-views] no view configs found");
    process.exit(0);
  }

  const concurrency = Math.min(
    configs.length,
    Math.max(1, os.cpus().length - 1),
  );
  const failures = [];
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= configs.length) return;
      const result = await buildView(configs[index]);
      console.log(`[build-views] ${result.label}`);
      if (result.output.length > 0) {
        process.stdout.write(result.output);
      }
      if (result.status !== 0) {
        failures.push(result);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (failures.length > 0) {
    console.error(
      `[build-views] ${failures.length} view build(s) failed: ${failures
        .map((failure) => failure.label)
        .join(", ")}`,
    );
    const exitStatus =
      failures.find((failure) => failure.status > 0)?.status ?? 1;
    process.exit(exitStatus);
  }

  // Every freshly built bundle must (a) exist and (b) import only specifiers
  // DynamicViewLoader can rewrite at runtime — otherwise the view ships but
  // fails to load in the browser ("Failed to resolve module specifier").
  const { validateViewBundles } = await import(
    "./view-bundle-import-guard.mjs"
  );
  const { violations, missingBundles } = await validateViewBundles();
  // The guard scans every configured plugin; a `--filter` run only built a
  // subset, so only hold the built subset to the "must emit a bundle" rule.
  const builtPluginNames = new Set(
    configs.map((configPath) => path.basename(path.dirname(configPath))),
  );
  const missingFromBuilt = missingBundles.filter((bundle) =>
    builtPluginNames.has(bundle.name),
  );
  const missingReport = missingBundleReport(missingFromBuilt);
  if (missingReport) {
    console.error(missingReport);
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error(
      `[build-views] ${violations.length} view bundle(s) import specifiers the host cannot rewrite:`,
    );
    for (const v of violations) {
      console.error(`  ✗ ${v.plugin}: ${v.specifier}`);
    }
    console.error(
      "[build-views] Import these from a host-provided specifier (e.g. the " +
        "`@elizaos/ui/components` barrel) instead of a deep subpath.",
    );
    process.exit(1);
  }
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
