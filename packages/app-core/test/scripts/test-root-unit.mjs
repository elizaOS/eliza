import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTestEnv,
  resolveNodeCmd,
  runManagedTestCommand,
} from "./managed-test-command.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// test/scripts → repo root (same as test-runner.mjs)
const repoRoot = path.resolve(here, "..", "..", "..", "..", "..");
const nodeCmd = resolveNodeCmd();
const unitEnv = buildTestEnv(repoRoot);

const unitShards = [
  {
    label: "unit:agent-src",
    patterns: ["eliza/packages/agent/src"],
  },
  {
    label: "unit:agent-tests",
    patterns: ["eliza/packages/agent/test"],
  },
  {
    label: "unit:app-core",
    patterns: ["eliza/packages/app-core/src", "eliza/packages/shared/src"],
  },
  {
    label: "unit:plugins",
    patterns: [
      "eliza/packages/agent/src/runtime/roles/test",
      "eliza/apps/app-lifeops/src/selfcontrol",
      "packages/plugin-wechat/src",
      "eliza/plugins/plugin-music-player/src",
      "eliza/plugins/plugin-discord/typescript/__tests__/identity.test.ts",
    ],
  },
  {
    label: "unit:workspace",
    patterns: [
      "src",
      "scripts",
      "eliza/packages/app-core/platforms/electrobun/src",
      "apps/chrome-extension",
      "test/format-error.test.ts",
    ],
  },
];

for (const shard of unitShards) {
  await runManagedTestCommand({
    repoRoot,
    lockName: "unit",
    label: shard.label,
    command: nodeCmd,
    args: [
      "./node_modules/.bin/vitest",
      "run",
      "--config",
      "test/vitest/default.config.ts",
      "--reporter=dot",
      ...shard.patterns,
    ],
    cwd: repoRoot,
    env: unitEnv,
  });
}
