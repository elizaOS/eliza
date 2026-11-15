/** Runs actual cache-adapter and HTTP loader regressions for the SWR model. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath("cloud-formal", "conformance", "cache-swr");
mkdirSync(output, { recursive: true });
const files = [
  "packages/cloud/shared/src/lib/cache/client.ts",
  "packages/cloud/shared/src/lib/cache/client-swr.test.ts",
  "packages/cloud/shared/src/lib/cache/adapters/memory-cache-adapter.ts",
  "packages/cloud/shared/src/lib/cache/adapters/node-redis-adapter.ts",
  "packages/cloud/quint/cache_swr_lifecycle.qnt",
];
const args = ["--conditions=eliza-source", "test", files[1]];
const result = spawnSync("bun", args, {
  cwd: root,
  env: process.env,
  encoding: "utf8",
  timeout: 90_000,
  maxBuffer: 8 * 1024 * 1024,
});
const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(path.join(output, "tests.log"), log);
writeFileSync(
  path.join(output, "result.json"),
  `${JSON.stringify(
    {
      command: ["bun", ...args],
      backend: process.env.CACHE_SWR_TEST_REDIS_BINARY
        ? "local-redis"
        : "production-memory-adapter",
      deadlineMs:
        process.env.CACHE_SWR_TEST_REAL_DEADLINE === "1" ? 30_000 : 100,
      sources: Object.fromEntries(
        files.map((file) => [
          file,
          createHash("sha256")
            .update(readFileSync(path.join(root, file)))
            .digest("hex"),
        ]),
      ),
      exitCode: result.status,
      error: result.error?.message,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(log);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(
    `Cache SWR conformance failed: ${result.status ?? result.signal}`,
  );
