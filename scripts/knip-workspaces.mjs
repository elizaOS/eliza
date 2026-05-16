#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, delimiter, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ROOT_KNIP_CONFIG = existsSync(join(ROOT, "knip.json"))
  ? "knip.json"
  : null;

const DIRECTORY_SCOPED_WORKSPACES = new Set([
  "packages/cloud-sdk",
  "packages/agent",
  "packages/app-core",
  "packages/app-core/deploy/cloud-agent-template",
  "packages/app-core/platforms/electrobun",
  "packages/contracts",
  "packages/core",
  "packages/examples/farcaster-miniapp",
  "packages/os/linux/agent",
  "packages/prompts",
  "packages/shared",
  "plugins/plugin-agent-orchestrator",
  "plugins/plugin-app-control",
  "plugins/plugin-app-manager",
]);

const DIRECTORY_SCOPED_WORKSPACE_PREFIXES = [
  "packages/examples/",
  "packages/native-plugins/",
];

const WORKSPACE_SCOPED_WORKSPACES = new Set([
  "packages/examples/browser-extension",
]);

function usage() {
  console.log(`Usage: node scripts/knip-workspaces.mjs [options] [-- knip args]

Runs Knip once per workspace package so each package gets an isolated report
without forcing one huge monorepo analysis process.

Options:
  --filter, -f <text>     Run packages whose name/path matches text or glob.
  --include-root          Include the root package.json as a package.
  --fail-on-issues        Return non-zero when Knip reports issues.
  --fail-fast             Stop at the first failing workspace.
  --list                  Print matching packages without running Knip.
  --help, -h              Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    filters: [],
    includeRoot: false,
    failOnIssues: false,
    failFast: false,
    list: false,
    help: false,
    knipArgs: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--") {
      options.knipArgs.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--include-root") options.includeRoot = true;
    else if (arg === "--fail-on-issues") options.failOnIssues = true;
    else if (arg === "--fail-fast") options.failFast = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--filter" || arg === "-f") {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options.filters.push(...splitFilter(value));
      i += 1;
    } else if (arg.startsWith("--filter=")) {
      options.filters.push(...splitFilter(arg.slice("--filter=".length)));
    } else {
      options.knipArgs.push(arg);
    }
  }

  return options;
}

function splitFilter(value) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function expandPattern(pattern) {
  const dirs = [];
  const parts = pattern.split("/");

  function walk(base, partIndex) {
    if (partIndex >= parts.length) {
      if (existsSync(join(base, "package.json"))) dirs.push(base);
      return;
    }

    const segment = parts[partIndex];
    if (segment.includes("*") || segment.includes("?")) {
      if (!existsSync(base) || !statSync(base).isDirectory()) return;

      const regex = globToRegExp(segment);
      for (const entry of readdirSync(base)) {
        if (
          entry === "node_modules" ||
          entry === "dist" ||
          entry.startsWith(".")
        ) {
          continue;
        }
        const fullPath = join(base, entry);
        if (regex.test(entry) && statSync(fullPath).isDirectory()) {
          walk(fullPath, partIndex + 1);
        }
      }
      return;
    }

    if (segment !== "node_modules") walk(join(base, segment), partIndex + 1);
  }

  walk(ROOT, 0);
  return dirs;
}

function collectWorkspaces(includeRoot) {
  const rootPackage = readJson(join(ROOT, "package.json"));
  const workspacePatterns = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : (rootPackage.workspaces?.packages ?? []);
  const byRealPath = new Map();

  if (includeRoot) {
    byRealPath.set(realpathSync(ROOT), {
      name: rootPackage.name ?? ".",
      path: ".",
      dir: ROOT,
    });
  }

  for (const pattern of workspacePatterns) {
    for (const dir of expandPattern(pattern)) {
      const packagePath = join(dir, "package.json");
      if (!existsSync(packagePath)) continue;
      const pkg = readJson(packagePath);
      const real = realpathSync(dir);
      byRealPath.set(real, {
        name: pkg.name ?? relative(ROOT, dir),
        path: normalizePath(relative(ROOT, dir)),
        dir,
      });
    }
  }

  return Array.from(byRealPath.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

function matchesFilter(pkg, filters) {
  if (filters.length === 0) return true;
  return filters.some((filter) => {
    const normalized = normalizePath(filter);
    if (normalized.includes("*") || normalized.includes("?")) {
      const regex = globToRegExp(normalized);
      return regex.test(pkg.path) || regex.test(pkg.name);
    }
    return pkg.path.includes(normalized) || pkg.name.includes(normalized);
  });
}

function isDirectoryScopedWorkspace(pkgPath) {
  return (
    !WORKSPACE_SCOPED_WORKSPACES.has(pkgPath) &&
    (DIRECTORY_SCOPED_WORKSPACES.has(pkgPath) ||
      DIRECTORY_SCOPED_WORKSPACE_PREFIXES.some((prefix) =>
        pkgPath.startsWith(prefix),
      ))
  );
}

function getConfigArgs(pkg, isDirectoryScoped) {
  if (!ROOT_KNIP_CONFIG) return [];
  if (!isDirectoryScoped) return ["--config", ROOT_KNIP_CONFIG];
  return [
    "--config",
    normalizePath(relative(pkg.dir, join(ROOT, ROOT_KNIP_CONFIG))),
  ];
}

function getKnipCommand() {
  const bin = join(ROOT, "node_modules", ".bin", "knip");
  if (existsSync(bin)) return { command: bin, prefixArgs: [] };

  const bunPath = process.env.PATH?.split(delimiter)
    .map((part) => join(part, "bun"))
    .find(
      (candidate) => existsSync(candidate) && basename(candidate) === "bun",
    );
  if (bunPath) return { command: bunPath, prefixArgs: ["x", "knip"] };

  return { command: "npx", prefixArgs: ["knip"] };
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const packages = collectWorkspaces(options.includeRoot).filter((pkg) =>
  matchesFilter(pkg, options.filters),
);

if (packages.length === 0) {
  console.error(
    `No workspace packages matched: ${options.filters.join(", ") || "<all>"}`,
  );
  process.exit(1);
}

if (options.list) {
  for (const pkg of packages) console.log(`${pkg.name}\t${pkg.path}`);
  process.exit(0);
}

const { command, prefixArgs } = getKnipCommand();
const failures = [];

console.log(`Knip workspace packages: ${packages.length}`);
console.log(
  `Mode: ${options.failOnIssues ? "fail on issues" : "report only"}\n`,
);

for (let index = 0; index < packages.length; index += 1) {
  const pkg = packages[index];
  const isDirectoryScoped = isDirectoryScopedWorkspace(pkg.path);
  const scopeArgs =
    pkg.path === "."
      ? ["--directory", "."]
      : isDirectoryScoped
        ? ["--directory", pkg.path]
        : ["--workspace", pkg.path];
  const args = [
    ...prefixArgs,
    ...getConfigArgs(pkg, isDirectoryScoped),
    ...scopeArgs,
    "--no-config-hints",
    "--no-progress",
  ];

  if (!options.failOnIssues) args.push("--no-exit-code");
  args.push(...options.knipArgs);

  console.log(`[${index + 1}/${packages.length}] ${pkg.name} (${pkg.path})`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(result.error.message);
    failures.push(pkg);
  } else if (result.status !== 0) {
    failures.push(pkg);
  }

  if (options.failFast && failures.length > 0) break;
  if (index < packages.length - 1) console.log("");
}

if (failures.length > 0) {
  console.error("\nKnip failed for:");
  for (const pkg of failures) console.error(`- ${pkg.name} (${pkg.path})`);
  process.exit(1);
}
