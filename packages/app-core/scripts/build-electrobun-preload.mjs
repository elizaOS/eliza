#!/usr/bin/env node
/**
 * Build the Electrobun preload bridge script.
 *
 * Bun resolves symlinked source files from their real path. In the thin-app
 * layout that means the preload entrypoint lives upstream while dependencies
 * such as `electrobun/view` are installed in the branded overlay workspace.
 * We work around that by generating short-lived local build shims next to the
 * real source files and rewriting the single problematic package import to the
 * exact resolved file path from the overlay workspace.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveElectrobunDir } from "./lib/app-dir.mjs";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

function isElectrobunDir(dir) {
  return (
    existsSync(path.join(dir, "package.json")) &&
    existsSync(path.join(dir, "electrobun.config.ts")) &&
    existsSync(path.join(dir, "src", "bridge", "electrobun-preload.ts"))
  );
}

const ELECTROBUN_DIR =
  [process.cwd(), resolveElectrobunDir(repoRoot)].find(isElectrobunDir) ??
  (() => {
    throw new Error("Could not resolve Electrobun workspace directory");
  })();

const PRELOAD_SRC = path.join(
  ELECTROBUN_DIR,
  "src",
  "bridge",
  "electrobun-preload.ts",
);
const DIRECT_RPC_SRC = path.join(
  ELECTROBUN_DIR,
  "src",
  "bridge",
  "electrobun-direct-rpc.ts",
);
const OUT = path.join(ELECTROBUN_DIR, "src", "preload.js");
const TEMP_DIRECT_RPC_SRC = path.join(
  ELECTROBUN_DIR,
  "src",
  "bridge",
  ".electrobun-direct-rpc.build.ts",
);
const TEMP_PRELOAD_SRC = path.join(
  ELECTROBUN_DIR,
  "src",
  "bridge",
  ".electrobun-preload.build.ts",
);

// Try to locate the bun binary
const bunBin = process.env.BUN_INSTALL
  ? path.join(process.env.BUN_INSTALL, "bin", "bun")
  : "bun";

function buildLocalEntrypoint() {
  const req = createRequire(path.join(ELECTROBUN_DIR, "package.json"));
  const electrobunViewEntry = req.resolve("electrobun/view");
  const directRpcSource = readFileSync(DIRECT_RPC_SRC, "utf8").replace(
    'from "electrobun/view";',
    `from ${JSON.stringify(electrobunViewEntry)};`,
  );
  const preloadSource = readFileSync(PRELOAD_SRC, "utf8").replace(
    'import "./electrobun-direct-rpc";',
    'import "./.electrobun-direct-rpc.build.ts";',
  );

  if (directRpcSource === readFileSync(DIRECT_RPC_SRC, "utf8")) {
    throw new Error(
      "Failed to patch electrobun preload source: expected electrobun/view import not found",
    );
  }
  if (preloadSource === readFileSync(PRELOAD_SRC, "utf8")) {
    throw new Error(
      "Failed to patch electrobun preload entry: expected direct-rpc import not found",
    );
  }

  writeFileSync(TEMP_DIRECT_RPC_SRC, directRpcSource, "utf8");
  writeFileSync(TEMP_PRELOAD_SRC, preloadSource, "utf8");
  return TEMP_PRELOAD_SRC;
}

const args = [
  "build",
  buildLocalEntrypoint(),
  "--target",
  "browser",
  "--format",
  "iife",
  "--outfile",
  OUT,
  "--minify",
];

try {
  execFileSync(bunBin, args, {
    cwd: ELECTROBUN_DIR,
    stdio: "inherit",
    env: process.env,
  });
} catch {
  process.exit(1);
} finally {
  rmSync(TEMP_DIRECT_RPC_SRC, { force: true });
  rmSync(TEMP_PRELOAD_SRC, { force: true });
}
