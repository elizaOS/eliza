#!/usr/bin/env node
/**
 * Builds every workspace-owned dynamic view bundle and refuses to report
 * success on incomplete discovery or missing output. The shared inventory
 * binds each `vite.config.views.*` file to its package script and expected
 * `dist/views/bundle.js`, which keeps this producer aligned with the downstream
 * import guard across nested workspaces and platforms (#15791, #16995).
 */
import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverViewBundleInventory,
  selectViewBundleTargets,
} from "./lib/view-bundle-inventory.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/** Absolute path to the bundle a plugin's view config is required to emit. */
export function expectedBundlePath(configPath) {
  return path.join(path.dirname(configPath), "dist", "views", "bundle.js");
}

/**
 * Resolve the generated output directory without allowing an existing path
 * component to redirect recursive cleanup outside its owning workspace.
 */
export function assertSafeViewOutputDirectory(configPath) {
  const workspace = path.resolve(path.dirname(configPath));
  const output = path.resolve(path.dirname(expectedBundlePath(configPath)));
  if (
    path.relative(workspace, output).split(path.sep).join("/") !== "dist/views"
  ) {
    throw new Error(
      "[build-views] view output must be workspace-local dist/views",
    );
  }
  let current = workspace;
  for (const segment of ["dist", "views"]) {
    current = path.join(current, segment);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `[build-views] refusing to clean symlinked output path: ${current}`,
        );
      }
      if (!metadata.isDirectory()) {
        throw new Error(
          `[build-views] output path component is not a directory: ${current}`,
        );
      }
    } catch (error) {
      // error-policy:J3 an output directory that does not exist is clean
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return output;
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

/** Parse the optional plugin filter without accepting ignored CLI input. */
export function parseViewFilter(args) {
  let filter;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--filter") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("[build-views] --filter requires a target name");
      }
      if (filter !== undefined) {
        throw new Error("[build-views] --filter may be specified only once");
      }
      filter = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--filter=")) {
      const value = arg.slice("--filter=".length);
      if (!value || value.startsWith("-")) {
        throw new Error("[build-views] --filter requires a target name");
      }
      if (filter !== undefined) {
        throw new Error("[build-views] --filter may be specified only once");
      }
      filter = value;
      continue;
    }
    throw new Error(`[build-views] unknown argument: ${arg}`);
  }
  return filter;
}

/** Keep native bundler startup within stable host and memory limits. */
export function viewBuildConcurrency({
  targetCount,
  cpuCount,
  platform = process.platform,
}) {
  if (targetCount === 0) return 0;
  if (platform === "darwin") return 1;
  return Math.min(targetCount, 4, Math.max(1, cpuCount - 1));
}

async function buildView(configPath) {
  const cwd = path.dirname(configPath);
  const label = path.relative(repoRoot, cwd);
  // The directory is generated output owned solely by this config. Clearing it
  // prevents a stale bundle or lazy chunk from surviving a later single-file
  // build and being mistaken for current output.
  await rm(assertSafeViewOutputDirectory(configPath), {
    force: true,
    recursive: true,
  });
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
  const filter = parseViewFilter(process.argv.slice(2));
  const inventory = discoverViewBundleInventory({ repoRoot });
  const targets = selectViewBundleTargets(inventory.targets, filter);
  const configs = targets.map(({ configAbsolute }) => configAbsolute);

  console.log(
    `[build-views] discovered ${inventory.targets.length} authoritative target(s); building ${targets.length}`,
  );

  const concurrency = viewBuildConcurrency({
    targetCount: configs.length,
    cpuCount: os.availableParallelism(),
  });
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
  const { violations, missingBundles, unexpectedChunks, unexpectedArtifacts } =
    await validateViewBundles({ enforceFreshOutputs: true });
  // The guard scans every configured plugin; a `--filter` run only built a
  // subset, so only hold the built subset to the "must emit a bundle" rule.
  const builtPluginNames = new Set(targets.map(({ name }) => name));
  const missingFromBuilt = missingBundles.filter((bundle) =>
    builtPluginNames.has(bundle.name),
  );
  const chunksFromBuilt = unexpectedChunks.filter((chunk) =>
    builtPluginNames.has(chunk.name),
  );
  const artifactsFromBuilt = unexpectedArtifacts.filter((artifact) =>
    builtPluginNames.has(artifact.name),
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
  if (chunksFromBuilt.length > 0) {
    console.error(
      `[build-views] ${chunksFromBuilt.length} unexpected JavaScript chunk(s) remain:`,
    );
    for (const chunk of chunksFromBuilt) {
      console.error(`  ✗ ${chunk.name}: ${chunk.relativeChunk}`);
    }
    process.exit(1);
  }
  if (artifactsFromBuilt.length > 0) {
    console.error(
      `[build-views] ${artifactsFromBuilt.length} unexpected sidecar artifact(s) remain:`,
    );
    for (const artifact of artifactsFromBuilt) {
      console.error(`  ✗ ${artifact.name}: ${artifact.relativeArtifact}`);
    }
    process.exit(1);
  }
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
