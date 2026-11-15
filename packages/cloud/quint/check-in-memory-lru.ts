/** Runs the production LRU cache's capacity and recency regressions. */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath("cloud-formal", "conformance", "in-memory-lru");
mkdirSync(output, { recursive: true });
const result = spawnSync(
  "bun",
  ["test", "packages/cloud/shared/src/lib/cache/in-memory-lru-cache.test.ts"],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  },
);
const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(path.join(output, "tests.log"), log);
process.stdout.write(log);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(`LRU conformance failed: ${result.status ?? result.signal}`);
