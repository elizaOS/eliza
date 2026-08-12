#!/usr/bin/env node
/**
 * Remove one or more paths recursively. Uses fs.rmSync for reliable deletion on
 * macOS/APFS under parallel builds (shell rm -rf can sporadically fail with
 * "Directory not empty" when the tree is huge or files are busy).
 */

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const RETRYABLE_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM", "ETXTBSY"]);

export function printHelp() {
  console.log(`
Usage: node scripts/rm-path-recursive.mjs [options] <path...>

Recursively remove files or directories with retries for lock/busy conditions.

Options:
  -h, --help            Show this help message
  --dry-run             Show paths that would be removed without deleting them
  --max-retries <count> Maximum retry attempts for locked files (default: 5)
  --retry-delay-ms <ms> Initial delay in milliseconds between retries (default: 50)

Examples:
  node scripts/rm-path-recursive.mjs dist
  node scripts/rm-path-recursive.mjs build coverage
  node scripts/rm-path-recursive.mjs --dry-run dist
`);
}

export function parseArgs(args = []) {
  const options = {
    help: false,
    dryRun: false,
    maxRetries: 5,
    retryDelayMs: 50,
    targets: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg.startsWith("--max-retries=")) {
      const val = Number.parseInt(arg.slice("--max-retries=".length), 10);
      if (Number.isNaN(val) || val < 1) {
        throw new Error(
          `Invalid --max-retries value: ${arg.slice("--max-retries=".length)}`,
        );
      }
      options.maxRetries = val;
    } else if (arg === "--max-retries") {
      const next = args[++i];
      const val = Number.parseInt(next ?? "", 10);
      if (!next || Number.isNaN(val) || val < 1) {
        throw new Error("--max-retries requires a positive integer value");
      }
      options.maxRetries = val;
    } else if (arg.startsWith("--retry-delay-ms=")) {
      const val = Number.parseInt(arg.slice("--retry-delay-ms=".length), 10);
      if (Number.isNaN(val) || val < 0) {
        throw new Error(
          `Invalid --retry-delay-ms value: ${arg.slice("--retry-delay-ms=".length)}`,
        );
      }
      options.retryDelayMs = val;
    } else if (arg === "--retry-delay-ms") {
      const next = args[++i];
      const val = Number.parseInt(next ?? "", 10);
      if (!next || Number.isNaN(val) || val < 0) {
        throw new Error(
          "--retry-delay-ms requires a non-negative integer value",
        );
      }
      options.retryDelayMs = val;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.targets.push(arg);
    }
  }

  if (!options.help && options.targets.length === 0) {
    throw new Error("Missing required path argument. Use --help for usage.");
  }

  return options;
}

export async function removePathRecursive(targetRel, options = {}) {
  const dryRun = options.dryRun ?? false;
  const maxRetries = options.maxRetries ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const rmFn = options.rmFn ?? rmSync;

  const target = path.resolve(process.cwd(), targetRel);

  if (dryRun) {
    console.log(`[rm-path-recursive] (dry-run) Would remove: ${target}`);
    return { target, deleted: false, attempts: 0, dryRun: true };
  }

  if (!existsSync(target)) {
    return { target, deleted: false, attempts: 0, dryRun: false };
  }

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      rmFn(target, { recursive: true, force: true });
      return { target, deleted: true, attempts: attempt + 1, dryRun: false };
    } catch (e) {
      const code =
        e && typeof e === "object" && "code" in e ? e.code : undefined;
      if (code === "ENOENT") {
        return { target, deleted: false, attempts: attempt + 1, dryRun: false };
      }
      if (
        typeof code === "string" &&
        RETRYABLE_CODES.has(code) &&
        attempt < maxRetries - 1
      ) {
        await delay(retryDelayMs * (attempt + 1));
        continue;
      }
      throw e;
    }
  }

  return { target, deleted: false, attempts: maxRetries, dryRun: false };
}

export async function runCli(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      printHelp();
      return 0;
    }

    for (const rel of options.targets) {
      await removePathRecursive(rel, options);
    }

    return 0;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

export async function main(args = process.argv.slice(2)) {
  const exitCode = await runCli(args);
  if (invokedDirectly) {
    process.exit(exitCode);
  }
  return exitCode;
}

const invokedDirectly =
  import.meta.main ||
  (Boolean(process.argv[1]) &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main();
}
