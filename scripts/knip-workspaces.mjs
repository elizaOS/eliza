#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ROOT_KNIP_CONFIG = existsSync(join(ROOT, "knip.json"))
  ? "knip.json"
  : null;
function usage() {
  console.log(`Usage: node scripts/knip-workspaces.mjs [options] [-- knip args]

Runs Knip once per workspace package from the repository root so Knip keeps
workspace dependency context without sharing one large analysis process. The
root knip.json is used for each run so package-local config drift does not
drop shared ignore rules.

Options:
  --filter, -f <text>     Run only packages whose name/path matches text or glob.
                          Repeat or comma-separate to include multiple packages.
  --include-root          Include the root package.json as a package.
  --fail-on-issues        Let Knip return non-zero for reported issues.
  --fail-fast             Stop after the first failing Knip invocation.
  --list                  Print matching packages without running Knip.
  --help, -h              Show this help.

Examples:
  bun run knip
  bun run knip -- --filter plugins/plugin-tailscale
  bun run knip:strict -- --filter @elizaos/core -- --dependencies
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

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--include-root") {
      options.includeRoot = true;
      continue;
    }

    if (arg === "--fail-on-issues") {
      options.failOnIssues = true;
      continue;
    }

    if (arg === "--fail-fast") {
      options.failFast = true;
      continue;
    }

    if (arg === "--list") {
      options.list = true;
      continue;
    }

    if (arg === "--filter" || arg === "-f") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      options.filters.push(...splitFilter(value));
      i += 1;
      continue;
    }

    if (arg.startsWith("--filter=")) {
      options.filters.push(...splitFilter(arg.slice("--filter=".length)));
      continue;
    }

    options.knipArgs.push(arg);
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

function expandPattern(pattern) {
  const dirs = [];
  const parts = pattern.split("/");

  function walk(base, partIndex) {
    if (partIndex >= parts.length) {
      if (existsSync(join(base, "package.json"))) {
        dirs.push(base);
      }
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

    if (segment !== "node_modules") {
      walk(join(base, segment), partIndex + 1);
    }
  }

  walk(ROOT, 0);
  return dirs;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function collectWorkspaces(includeRoot) {
  const rootPkg = readJson(join(ROOT, "package.json"));
  const workspacePatterns = rootPkg.workspaces ?? [];
  const dirs = new Set();

  for (const pattern of workspacePatterns) {
    for (const dir of expandPattern(pattern)) {
      dirs.add(resolve(dir));
    }
  }

  if (includeRoot) {
    dirs.add(ROOT);
  }

  return Array.from(dirs)
    .map((dir) => {
      const pkg = readJson(join(dir, "package.json"));
      const path = relative(ROOT, dir) || ".";
      return {
        dir,
        path,
        name: pkg.name ?? path,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function matchesFilter(pkg, filters) {
  if (filters.length === 0) return true;

  const values = [pkg.name, pkg.path, pkg.dir];
  return filters.some((filter) =>
    values.some((value) => {
      if (filter.includes("*") || filter.includes("?")) {
        return globToRegExp(filter).test(value);
      }
      return value.includes(filter);
    }),
  );
}

function getKnipCommand() {
  const localBin = join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "knip.cmd" : "knip",
  );
  const bunCommand = getBunCommand();

  if (existsSync(localBin)) {
    if (bunCommand) {
      return { command: bunCommand, prefixArgs: [localBin] };
    }

    return { command: localBin, prefixArgs: [] };
  }

  return { command: "bunx", prefixArgs: ["knip"] };
}

function getBunCommand() {
  const candidates = [
    process.env.npm_execpath,
    process.env.BUN_INSTALL
      ? join(process.env.BUN_INSTALL, "bin", "bun")
      : null,
    ...getPathCandidates("bun"),
  ];

  for (const candidate of candidates) {
    if (isBunExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getPathCandidates(command) {
  const path = process.env.PATH;
  if (!path) return [];

  const names =
    process.platform === "win32"
      ? [`${command}.exe`, `${command}.cmd`]
      : [command];
  return path
    .split(delimiter)
    .flatMap((dir) => names.map((name) => join(dir, name)));
}

function isBunExecutable(candidate) {
  if (!candidate) return false;

  const normalized = candidate.replace(/\\/g, "/");
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  return /^bun(?:\.exe)?$/.test(fileName) && existsSync(candidate);
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
  for (const pkg of packages) {
    console.log(`${pkg.name}\t${pkg.path}`);
  }
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
  const scopeArgs =
    pkg.path === "." ? ["--directory", "."] : ["--workspace", pkg.path];
  const configArgs = ROOT_KNIP_CONFIG ? ["--config", ROOT_KNIP_CONFIG] : [];
  const args = [
    ...prefixArgs,
    ...configArgs,
    ...scopeArgs,
    "--no-config-hints",
    "--no-progress",
  ];

  if (!options.failOnIssues) {
    args.push("--no-exit-code");
  }

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

  if (options.failFast && failures.length > 0) {
    break;
  }

  if (index < packages.length - 1) {
    console.log("");
  }
}

if (failures.length > 0) {
  console.error("\nKnip failed for:");
  for (const pkg of failures) {
    console.error(`- ${pkg.name} (${pkg.path})`);
  }
  process.exit(1);
}
