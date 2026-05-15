import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDir, "..", "..");
const bun = process.env.BUN || process.env.npm_execpath || "bun";
const extraArgs = process.argv.slice(2);

const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => relative(appRoot, join(testDir, name)));

for (const testFile of testFiles) {
  console.log(`[api-e2e] START ${testFile}`);
  const result = spawnSync(
    bun,
    [
      "test",
      "--max-concurrency=1",
      "--preload",
      "../../packages/tests/e2e/preload.ts",
      testFile,
      "--timeout",
      "120000",
      ...extraArgs,
    ],
    {
      cwd: appRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        TEST_SERVER_SCRIPT: process.env.TEST_SERVER_SCRIPT || "dev",
      },
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    console.error(`[api-e2e] FAIL ${testFile}`);
    process.exit(result.status ?? 1);
  }
  console.log(`[api-e2e] PASS ${testFile}`);
}
