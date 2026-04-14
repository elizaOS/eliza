import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTestEnv,
  resolveNodeCmd,
  runManagedTestCommand,
} from "./managed-test-command.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Script lives at eliza/packages/app-core/test/scripts/ — repo root is 5 levels up
const repoRoot = path.resolve(here, "..", "..", "..", "..", "..");
const bunCmd = process.env.npm_execpath || process.env.BUN || "bun";
const nodeCmd = resolveNodeCmd();
const appRoot = path.join(repoRoot, "apps", "app");
const unitShardCount = 1;

await runManagedTestCommand({
  repoRoot,
  lockName: "app-unit",
  label: "app-unit",
  command: nodeCmd,
  args: ["./node_modules/.bin/vitest", "run", "--passWithNoTests"],
  cwd: appRoot,
  env: buildTestEnv(appRoot),
});

for (let shard = 1; shard <= unitShardCount; shard += 1) {
  await runManagedTestCommand({
    repoRoot,
    lockName: `unit-${shard}`,
    label: `unit ${shard}/${unitShardCount}`,
    command: nodeCmd,
    args: [
      "./node_modules/.bin/vitest",
      "run",
      "--config",
      "test/vitest/default.config.ts",
      `--shard=${shard}/${unitShardCount}`,
    ],
    cwd: repoRoot,
    env: buildTestEnv(repoRoot),
  });
}

await runManagedTestCommand({
  repoRoot,
  lockName: "integration",
  label: "integration",
  command: bunCmd,
  args: ["run", "test:integration"],
  cwd: repoRoot,
  env: buildTestEnv(repoRoot),
});

await runManagedTestCommand({
  repoRoot,
  lockName: "e2e",
  label: "e2e",
  command: bunCmd,
  args: ["run", "test:e2e"],
  cwd: repoRoot,
  env: buildTestEnv(repoRoot),
});

await runManagedTestCommand({
  repoRoot,
  lockName: "live-smoke",
  label: "live-smoke",
  command: bunCmd,
  args: ["run", "test:live:smoke"],
  cwd: repoRoot,
  env: {
    ...buildTestEnv(repoRoot),
    ELIZA_LIVE_TEST: "1",
    ELIZA_LIVE_TEST: "1",
  },
});

await runManagedTestCommand({
  repoRoot,
  lockName: "orchestrator-integration",
  label: "orchestrator-integration",
  command: bunCmd,
  args: ["run", "test:orchestrator:integration"],
  cwd: repoRoot,
  env: buildTestEnv(repoRoot),
});
