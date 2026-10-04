#!/usr/bin/env node
/** Run app script tests that need Node or Bun; Vitest owns its own discovered lane. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverScriptTestLanes } from "./lib/script-test-lanes.ts";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const lanes = discoverScriptTestLanes(appRoot);
for (const [command, args] of [
  [process.execPath, ["--test", "--test-concurrency=1", ...lanes["node:test"]]],
  // These suites install subprocess proxies and mutate process-wide platform
  // settings. Keep each file's module cache and globals independent.
  ["bun", ["test", "--isolate", "--timeout=120000", ...lanes["bun:test"]]],
] as const) {
  const result = spawnSync(command, [...args], {
    cwd: appRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
