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

await import("./test-root-unit.mjs");

await runManagedTestCommand({
  repoRoot,
  lockName: "computeruse-real",
  label: "computeruse-real",
  command: bunCmd,
  args: ["run", "test"],
  cwd: path.join(repoRoot, "eliza", "plugins", "plugin-computeruse"),
  env: {
    ...buildTestEnv(repoRoot),
    ELIZA_LIVE_TEST: "1",
    COMPUTER_USE_BROWSER_HEADLESS:
      process.env.COMPUTER_USE_BROWSER_HEADLESS || "1",
  },
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
