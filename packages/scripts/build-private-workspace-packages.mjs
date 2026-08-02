#!/usr/bin/env node
/**
 * Build private/internal workspace packages whose `dist/` is referenced by
 * other workspace packages but not produced by any other install step.
 *
 * Why this exists: private workspace packages may ship dist artifacts that
 * consumers import directly. On a fresh clone
 * neither npm fetch nor the workspace symlink step produces those dist files
 * — only the package's own `bun run build` does — and nothing wires that
 * build into install, so `git clone … && bun install && bun run dev` fails
 * with ERR_MODULE_NOT_FOUND on the missing dist entry. (See #8143 for the
 * original repro and root cause.)
 *
 * This script builds each listed package in dependency order, idempotent:
 * skips a build when the expected `dist` artifact already exists. Order
 * matters because workspace packages may need an upstream package's `dist/`
 * declarations before their own TypeScript build can resolve imports.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildOnInstallPackages } from "./lib/script-metadata.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// Dependency-ordered set, resolved through the discovery seam. Each private
// package declares `elizaos.scripts.buildOnInstall = { sentinel, order }` in its
// own package.json — `order` builds leaves before dependents, and `sentinel`
// is the dist file whose presence proves it is already built. No package
// names live in this file.
const PACKAGES = resolveBuildOnInstallPackages({ repoRoot: REPO_ROOT }).map(
  (pkg) => ({ dir: pkg.dir, freshnessSentinel: pkg.sentinel }),
);

function log(msg) {
  process.stderr.write(`[build-private-workspace-packages] ${msg}\n`);
}

function buildPackage(pkg) {
  const pkgDir = path.join(REPO_ROOT, pkg.dir);
  const sentinel = path.join(pkgDir, pkg.freshnessSentinel);

  if (existsSync(sentinel)) {
    log(`skip ${pkg.dir} (already built: ${pkg.freshnessSentinel})`);
    return;
  }

  if (!existsSync(path.join(pkgDir, "package.json"))) {
    log(`skip ${pkg.dir} (package.json missing — workspace not checked out?)`);
    return;
  }

  log(`building ${pkg.dir} …`);
  const result = spawnSync("bun", ["run", "build"], {
    cwd: pkgDir,
    stdio: "inherit",
    // On Windows `bun` resolves through the npm shim — let the platform
    // PATH handle it.
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    log(
      `FAILED ${pkg.dir}: bun run build exited with ${result.status ?? result.signal ?? "?"}`,
    );
    process.exit(result.status ?? 1);
  }

  log(`built ${pkg.dir}`);
}

for (const pkg of PACKAGES) {
  buildPackage(pkg);
}
