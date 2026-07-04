#!/usr/bin/env node
/**
 * Verification runner for the first-party examples workspace.
 *
 * It discovers example package scripts, checks documentation coverage, and can
 * run typecheck, test, and build commands with a JSON report for CI.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const examplesRoot = path.join(repoRoot, "packages", "examples");
const skipDirs = new Set([
  ".git",
  ".next",
  ".next-build",
  ".turbo",
  "build",
  "dist",
  "node_modules",
]);
const validModes = new Set([
  "all",
  "build",
  "docs",
  "list",
  "test",
  "typecheck",
]);

function usage() {
  console.log(`Usage: node packages/examples/scripts/verify-examples.mjs [options]

Options:
  --mode <mode>       all, list, docs, typecheck, test, or build (default: all)
  --dry-run           Print commands without executing them
  --json <file>       Write a JSON report
  --timeout <ms>      Per-command timeout in milliseconds (default: 900000)
  --help              Show this help
`);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    json: null,
    mode: "all",
    timeoutMs: 900_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--json") {
      options.json = argv[++index];
      if (!options.json) throw new Error("--json requires a file path");
    } else if (arg === "--mode") {
      options.mode = argv[++index];
      if (!validModes.has(options.mode)) {
        throw new Error(`Unsupported mode "${options.mode}"`);
      }
    } else if (arg === "--timeout") {
      options.timeoutMs = Number(argv[++index]);
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error("--timeout requires a positive number");
      }
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }

  return options;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.name === "package.json") {
      files.push(fullPath);
    }
  }
  return files;
}

function relativeToRepo(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function getPackages() {
  return walk(examplesRoot)
    .sort()
    .map((packageFile) => {
      const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
      const dir = path.dirname(packageFile);
      return {
        dir,
        name: packageJson.name ?? relativeToRepo(dir),
        relativeDir: relativeToRepo(dir),
        scripts: packageJson.scripts ?? {},
      };
    });
}

function checkDocs(packages) {
  const failures = [];
  const rootReadmePath = path.join(examplesRoot, "README.md");
  const validationPath = path.join(examplesRoot, "VALIDATION.md");
  const setupGuidePath = path.join(examplesRoot, "setup-guide.html");

  for (const pkg of packages) {
    if (!existsSync(path.join(pkg.dir, "README.md"))) {
      failures.push({ package: pkg.relativeDir, reason: "missing README.md" });
    }
  }

  for (const file of [rootReadmePath, validationPath, setupGuidePath]) {
    if (!existsSync(file)) {
      failures.push({
        package: relativeToRepo(path.dirname(file)),
        reason: `missing ${path.basename(file)}`,
      });
    }
  }

  if (
    !existsSync(rootReadmePath) ||
    !existsSync(validationPath) ||
    !existsSync(setupGuidePath)
  ) {
    return failures;
  }

  const rootReadme = readFileSync(rootReadmePath, "utf8");
  const validation = readFileSync(validationPath, "utf8");
  const setupGuide = readFileSync(setupGuidePath, "utf8");

  for (const requiredLink of ["setup-guide.html", "VALIDATION.md"]) {
    if (!rootReadme.includes(requiredLink)) {
      failures.push({
        package: "packages/examples",
        reason: `README.md missing link to ${requiredLink}`,
      });
    }
  }

  for (const pkg of packages) {
    const exampleName = pkg.relativeDir.replace(/^packages\/examples\//, "");
    if (!validation.includes(`| \`${exampleName}\` |`)) {
      failures.push({
        package: pkg.relativeDir,
        reason: "missing row in VALIDATION.md example matrix",
      });
    }
  }

  for (const requiredText of [
    "Minecraft",
    "AWS",
    "GCP",
    "Cloudflare",
    "Convex",
    "Supabase",
    "Vercel",
    "Social bots",
    "Smartglasses",
    "Wallet/trading",
  ]) {
    if (!setupGuide.includes(requiredText)) {
      failures.push({
        package: "packages/examples",
        reason: `setup-guide.html missing ${requiredText} setup section`,
      });
    }
  }

  return failures;
}

function runCommand(pkg, script, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("bun", ["run", "--cwd", pkg.relativeDir, script], {
      cwd: repoRoot,
      stdio: "inherit",
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      resolve({
        durationMs: Date.now() - startedAt,
        package: pkg.relativeDir,
        script,
        status: "timeout",
      });
    }, timeoutMs);

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        durationMs: Date.now() - startedAt,
        package: pkg.relativeDir,
        script,
        signal,
        status: code === 0 ? "passed" : "failed",
      });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packages = getPackages();
  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    packages: packages.map((pkg) => ({
      name: pkg.name,
      path: pkg.relativeDir,
      scripts: Object.keys(pkg.scripts).sort(),
    })),
    results: [],
  };

  if (options.mode === "list") {
    for (const pkg of report.packages) {
      console.log(`${pkg.path} ${pkg.scripts.join(",")}`);
    }
  }

  if (options.mode === "docs" || options.mode === "all") {
    const failures = checkDocs(packages);
    if (failures.length === 0) {
      console.log("docs passed");
      report.results.push({ script: "docs", status: "passed" });
    } else {
      for (const failure of failures) {
        console.error(`${failure.package}: ${failure.reason}`);
      }
      report.results.push({ failures, script: "docs", status: "failed" });
    }
  }

  const scripts =
    options.mode === "all"
      ? ["typecheck", "test", "build"]
      : ["typecheck", "test", "build"].includes(options.mode)
        ? [options.mode]
        : [];

  for (const script of scripts) {
    for (const pkg of packages) {
      if (!pkg.scripts[script]) continue;
      const command = `bun run --cwd ${pkg.relativeDir} ${script}`;
      if (options.dryRun) {
        console.log(command);
        report.results.push({
          command,
          package: pkg.relativeDir,
          script,
          status: "planned",
        });
        continue;
      }

      console.log(`\n== ${script} ${pkg.relativeDir} ==`);
      report.results.push(await runCommand(pkg, script, options.timeoutMs));
    }
  }

  if (options.json) {
    const outputPath = path.resolve(repoRoot, options.json);
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${relativeToRepo(outputPath)}`);
  }

  const failed = report.results.some(
    (result) => result.status === "failed" || result.status === "timeout",
  );
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
