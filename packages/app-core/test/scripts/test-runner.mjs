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
const elizaRoot = path.join(repoRoot, "eliza");
const appCoreRoot = path.join(elizaRoot, "packages", "app-core");
const cloudRoot = path.join(elizaRoot, "cloud");
const stewardFiRoot = path.join(elizaRoot, "steward-fi");
const unitShardCount = 1;

await runManagedTestCommand({
  repoRoot,
  lockName: "app-unit",
  label: "app-unit",
  command: nodeCmd,
  args: ["./node_modules/.bin/vitest", "run"],
  cwd: appRoot,
  env: buildTestEnv(appRoot),
});

const homepageRoot = path.join(repoRoot, "apps", "homepage");
await runManagedTestCommand({
  repoRoot,
  lockName: "homepage-unit",
  label: "homepage-unit",
  command: nodeCmd,
  args: ["./node_modules/.bin/vitest", "run"],
  cwd: homepageRoot,
  env: buildTestEnv(homepageRoot),
});

await runManagedTestCommand({
  repoRoot,
  lockName: "app-core-unit",
  label: "app-core-unit",
  command: nodeCmd,
  args: [
    "./node_modules/.bin/vitest",
    "run",
    "src/components/shell/ComputerUseApprovalOverlay.test.tsx",
  ],
  cwd: appCoreRoot,
  env: buildTestEnv(appCoreRoot),
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
  lockName: "computeruse-real",
  label: "computeruse-real",
  command: bunCmd,
  args: ["run", "test"],
  cwd: path.join(repoRoot, "eliza", "plugins", "plugin-computeruse"),
  env: {
    ...buildTestEnv(repoRoot),
    MILADY_LIVE_TEST: "1",
    ELIZA_LIVE_TEST: "1",
    COMPUTER_USE_BROWSER_HEADLESS:
      process.env.COMPUTER_USE_BROWSER_HEADLESS || "1",
  },
});

await runManagedTestCommand({
  repoRoot,
  lockName: "e2e-all",
  label: "e2e-all",
  command: bunCmd,
  args: ["run", "test:e2e:all"],
  cwd: repoRoot,
  env: buildTestEnv(repoRoot),
});

await runManagedTestCommand({
  repoRoot,
  lockName: "scenarios-all",
  label: "scenarios-all",
  command: bunCmd,
  args: ["run", "test:scenarios"],
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
    MILADY_LIVE_TEST: "1",
    ELIZA_LIVE_TEST: "1",
  },
});

await runManagedTestCommand({
  repoRoot,
  lockName: "evm-live-rpc",
  label: "evm-live-rpc",
  command: bunCmd,
  args: ["run", "test:live:evm:rpc"],
  cwd: repoRoot,
  env: {
    ...buildTestEnv(repoRoot),
    MILADY_LIVE_TEST: "1",
    ELIZA_LIVE_TEST: "1",
  },
});

await runManagedTestCommand({
  repoRoot,
  lockName: "evm-live-transfer",
  label: "evm-live-transfer",
  command: bunCmd,
  args: [
    "x",
    "vitest",
    "run",
    "--config",
    "test/vitest/real.config.ts",
    "eliza/plugins/plugin-evm/typescript/__tests__/integration/transfer.live.test.ts",
  ],
  cwd: repoRoot,
  env: {
    ...buildTestEnv(repoRoot),
    MILADY_LIVE_TEST: "1",
    ELIZA_LIVE_TEST: "1",
  },
});

await runManagedTestCommand({
  repoRoot,
  lockName: "ui-playwright",
  label: "ui-playwright",
  command: bunCmd,
  args: ["run", "test:ui:playwright"],
  cwd: repoRoot,
  env: buildTestEnv(repoRoot),
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

await runManagedTestCommand({
  repoRoot,
  lockName: "eliza-all",
  label: "eliza-all",
  command: bunCmd,
  args: ["run", "test"],
  cwd: elizaRoot,
  env: buildTestEnv(elizaRoot),
});

await runManagedTestCommand({
  repoRoot,
  lockName: "cloud-all",
  label: "cloud-all",
  command: bunCmd,
  args: ["run", "test"],
  cwd: cloudRoot,
  env: buildTestEnv(cloudRoot),
});

await runManagedTestCommand({
  repoRoot,
  lockName: "steward-fi-all",
  label: "steward-fi-all",
  command: bunCmd,
  args: ["run", "test"],
  cwd: stewardFiRoot,
  env: buildTestEnv(stewardFiRoot),
});
