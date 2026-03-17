/**
 * Vitest globalSetup for E2E tests.
 *
 * Runs `tsdown` before any E2E test file is loaded so that `dist/` is
 * always present — even when the test suite is invoked without a prior
 * manual build (e.g. `bun run test` in CI).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function setup(): void {
  const distIndex = path.join(packageRoot, "dist", "index");

  if (fs.existsSync(distIndex)) {
    // Already built — skip to keep the fast path fast.
    return;
  }

  // eslint-disable-next-line no-console
  console.log("[e2e-global-setup] dist/ not found — running tsdown…");
  execSync("npx tsdown", { cwd: packageRoot, stdio: "inherit" });
}
