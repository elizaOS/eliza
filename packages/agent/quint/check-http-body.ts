/** Replays body-limit admission through real HTTP requests and keep-alive. */
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "packages/agent/vitest.config.ts",
    "packages/agent/src/api/hono-adapter.test.ts",
    "--maxWorkers=1",
  ],
  { cwd: root, stdio: "inherit", env: process.env },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;
