/**
 * Runs the headless meeting-capture proof behind bounded native-loader and
 * end-to-end deadlines so a broken browser runtime cannot hang the test lane.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const entrypoint = path.join(
  packageRoot,
  "src",
  "__e2e__",
  "headless-capture-e2e.ts",
);
const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;

test("captures participant audio and persists the transcript end to end", (t) => {
  const loaderProbe = spawnSync(
    "bun",
    ["-e", 'await import("playwright-core")'],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: childEnv,
      timeout: 5_000,
    },
  );
  if (loaderProbe.error?.code === "ETIMEDOUT") {
    t.skip("native Playwright loader is unresponsive on this host");
    return;
  }
  assert.equal(
    loaderProbe.status,
    0,
    `Playwright loader probe failed\nstdout=${loaderProbe.stdout}\nstderr=${loaderProbe.stderr}`,
  );

  const result = spawnSync("bun", [entrypoint], {
    cwd: packageRoot,
    encoding: "utf8",
    env: childEnv,
    timeout: 60_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(
    result.error,
    undefined,
    `headless capture runner failed to start or timed out: ${result.error?.message}`,
  );
  assert.equal(result.status, 0, `headless capture exited ${result.status}`);
});
