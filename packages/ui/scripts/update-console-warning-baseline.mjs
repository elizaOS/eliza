/**
 * Captures current per-test console warnings so the unit suite can reject new
 * warning fingerprints and count increases while legacy noise is paid down.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { replaceConsoleWarningBaseline } from "./console-warning-baseline.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const captureDirectory = mkdtempSync(join(tmpdir(), "eliza-ui-console-"));
const capturePrefix = join(captureDirectory, "warnings");
const result = spawnSync(
  "bunx",
  [
    "vitest",
    "run",
    "--config",
    "./vitest.config.ts",
    "--reporter=dot",
    "--maxWorkers=4",
  ],
  {
    cwd: packageRoot,
    env: {
      ...process.env,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --no-experimental-webstorage --disable-warning=ExperimentalWarning`.trim(),
      UPDATE_TEST_CONSOLE_BASELINE: capturePrefix,
    },
    stdio: "inherit",
  },
);

const baselinePath = resolve(packageRoot, "test/console-warning-baseline.json");
let fingerprintCount = null;
try {
  fingerprintCount = replaceConsoleWarningBaseline({
    captureDirectory,
    baselinePath,
    runStatus: result.status,
  });
} finally {
  rmSync(captureDirectory, { recursive: true });
}
if (fingerprintCount === null) {
  console.error(
    `Unit suite failed${result.signal ? ` (${result.signal})` : ""}; console warning baseline was not changed.`,
  );
} else {
  console.log(
    `Updated console warning baseline with ${fingerprintCount} warning fingerprints.`,
  );
}
process.exitCode = result.status ?? 1;
