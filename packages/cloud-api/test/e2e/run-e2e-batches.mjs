import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDir, "..", "..");
const bun = process.env.BUN || process.env.npm_execpath || "bun";
const extraArgs = process.argv.slice(2);
const requireServer =
  process.env.REQUIRE_E2E_SERVER === "1" ||
  process.env.REQUIRE_E2E_SERVER === "true";
const baseUrl =
  process.env.TEST_API_BASE_URL?.trim() ||
  process.env.TEST_BASE_URL?.trim() ||
  "http://localhost:8787";

async function isServerReachable() {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

if (!requireServer && !(await isServerReachable())) {
  console.warn(
    `[api-e2e] ${baseUrl} did not respond to /api/health; skipping Worker e2e batch. Set REQUIRE_E2E_SERVER=1 to make this a hard failure.`,
  );
  process.exit(0);
}

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
      "./test/e2e/preload.ts",
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
