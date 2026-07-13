#!/usr/bin/env node
// Wrapper around `pepr build` so the operator package participates in the
// turbo build without breaking Windows dev environments.
//
// Pepr's CLI (v1.2.x) was written for POSIX hosts: it does `lastIndexOf("pepr/")`
// to locate its template root, calls `execFileSync("npm", ...)` without
// shell:true, and resolves output paths through `path/posix`. Each of those
// fails on Windows, and the package is a Kubernetes deployment artifact that
// only needs to build on Linux CI before pushing the container image. So on
// Windows we no-op and let Linux CI do the real build.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const pkgDir = path.resolve(path.dirname(__filename), "..");
const legacyApiHook = path.join(
  path.dirname(__filename),
  "typescript-legacy-api-hook.cjs",
);

if (process.platform === "win32") {
  console.log(
    "[operator/build] skipped on win32 — pepr CLI is POSIX-only; the operator builds on Linux CI before container push.",
  );
  process.exit(0);
}

const env = {
  ...process.env,
  ELIZA_OPERATOR_SKIP_CRD_REGISTER: "1",
  // Pepr 1.2 and its formatter still consume the removed TypeScript compiler
  // API. Keep their process on Microsoft's official TypeScript 6 API bridge;
  // Pepr's emitted-code compiler remains the workspace TypeScript 7 `tsc`.
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${legacyApiHook}`]
    .filter(Boolean)
    .join(" "),
  PATH: `${path.join(pkgDir, "scripts")}${path.delimiter}${process.env.PATH ?? ""}`,
};

const peprArgs = process.argv.slice(2);
const result = spawnSync(
  "bunx",
  ["pepr", ...(peprArgs.length > 0 ? peprArgs : ["build"])],
  {
    cwd: pkgDir,
    env,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
