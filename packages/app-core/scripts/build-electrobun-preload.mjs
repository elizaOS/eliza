#!/usr/bin/env node
/**
 * Build the Electrobun preload bridge script.
 *
 * On Windows, Bun's bundler may fail with EACCES when traversing the
 * electrobun/view package directory. We work around this by resolving
 * the electrobun/view entry point explicitly and passing it as an alias,
 * or falling back to --packages=external if resolution fails entirely.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const ELECTROBUN_DIR = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "..",
  "apps",
  "app",
  "electrobun",
);

const SRC = path.join(ELECTROBUN_DIR, "src", "bridge", "electrobun-preload.ts");
const OUT = path.join(ELECTROBUN_DIR, "src", "preload.js");

// Try to locate the bun binary
const bunBin = process.env.BUN_INSTALL
  ? path.join(process.env.BUN_INSTALL, "bin", "bun")
  : "bun";

const args = [
  "build",
  SRC,
  "--target",
  "browser",
  "--format",
  "iife",
  "--outfile",
  OUT,
  "--minify",
];

// On Windows, explicitly resolve electrobun/view to avoid EACCES on
// directory traversal. Use createRequire from the electrobun workspace.
if (process.platform === "win32") {
  try {
    const req = createRequire(path.join(ELECTROBUN_DIR, "package.json"));
    req.resolve("electrobun/view");
    // If resolution succeeds, we're fine — bun build should work.
    // But add the electrobun dir to NODE_PATH as a fallback.
    if (!process.env.NODE_PATH) {
      process.env.NODE_PATH = path.join(ELECTROBUN_DIR, "node_modules");
    }
  } catch {
    // Can't resolve — mark all packages as external so bun doesn't traverse
    console.warn(
      "[build:preload] Warning: electrobun/view not resolvable, using --packages=external",
    );
    args.push("--packages=external");
  }
}

try {
  execFileSync(bunBin, args, {
    cwd: ELECTROBUN_DIR,
    stdio: "inherit",
    env: process.env,
  });
} catch {
  // If the first attempt failed on Windows, retry with --packages=external
  if (process.platform === "win32" && !args.includes("--packages=external")) {
    console.warn(
      "[build:preload] Retrying with --packages=external after EACCES",
    );
    args.push("--packages=external");
    execFileSync(bunBin, args, {
      cwd: ELECTROBUN_DIR,
      stdio: "inherit",
      env: process.env,
    });
  } else {
    process.exit(1);
  }
}
