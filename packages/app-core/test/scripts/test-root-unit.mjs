import fs from "node:fs";
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

const unitTestExtensionPattern = /\.test\.tsx?$/;
const nonUnitTestNamePattern =
  /(?:[-.](?:live|real|integration|e2e)\.test|\.e2e\.spec)\.tsx?$/;

function toCliPath(absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function collectTestFiles(...relativeRoots) {
  const files = [];

  for (const relativeRoot of relativeRoots) {
    const absoluteRoot = path.join(repoRoot, relativeRoot);
    if (!fs.existsSync(absoluteRoot)) continue;

    const stat = fs.statSync(absoluteRoot);
    if (stat.isFile()) {
      if (
        unitTestExtensionPattern.test(absoluteRoot) &&
        !nonUnitTestNamePattern.test(absoluteRoot)
      ) {
        files.push(toCliPath(absoluteRoot));
      }
      continue;
    }

    const stack = [absoluteRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          stack.push(entryPath);
          continue;
        }
        if (
          entry.isFile() &&
          unitTestExtensionPattern.test(entry.name) &&
          !nonUnitTestNamePattern.test(entry.name)
        ) {
          files.push(toCliPath(entryPath));
        }
      }
    }
  }

  return files.sort();
}

function collectAppPluginTestFiles() {
  const appPluginsRoot = path.join(repoRoot, "eliza", "plugins");
  if (!fs.existsSync(appPluginsRoot)) return [];

  return fs
    .readdirSync(appPluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("app-"))
    .flatMap((entry) => collectTestFiles(`eliza/plugins/${entry.name}/test`));
}

function chunkFiles(label, files, chunkSize = 20) {
  if (files.length === 0) {
    return [{ label, patterns: [] }];
  }

  const chunks = [];
  for (let index = 0; index < files.length; index += chunkSize) {
    chunks.push({
      label:
        files.length <= chunkSize
          ? label
          : `${label}:${Math.floor(index / chunkSize) + 1}`,
      patterns: files.slice(index, index + chunkSize),
    });
  }
  return chunks;
}

const appTestFiles = collectAppPluginTestFiles();
const lifeOpsSourceTestFiles = collectTestFiles(
  "eliza/plugins/app-lifeops/src",
);
const appsAndPluginsSourceTestFiles = [
  ...collectTestFiles(
    "eliza/plugins/app-vincent/src",
    "eliza/plugins/app-shopify/src",
    "eliza/plugins/app-steward/src",
    "packages/plugin-wechat/src",
  ),
  ...[
    "eliza/plugins/plugin-discord/__tests__/smoke.test.ts",
    "eliza/plugins/plugin-discord/__tests__/draft-stream.test.ts",
  ].filter((file) => fs.existsSync(path.join(repoRoot, file))),
];
const workspaceTestFiles = collectTestFiles(
  "src",
  "scripts",
  "apps/chrome-extension",
  "eliza/test/helpers",
);

const unitShards = [
  {
    label: "unit:agent-src",
    patterns: [
      ...collectTestFiles(
        "eliza/packages/agent/src",
        "eliza/packages/agent/test",
      ),
    ],
  },
  {
    label: "unit:app-core",
    patterns: [
      ...collectTestFiles(
        "eliza/packages/app-core/src",
        "eliza/packages/shared/src",
        "eliza/packages/app-core/test/live-agent",
        "eliza/packages/app-core/scripts",
        "eliza/packages/native-plugins/llama/src",
      ),
      ...[
        "eliza/packages/app-core/platforms/electrobun/src/menu-reset-from-main.test.ts",
        "eliza/packages/app-core/platforms/electrobun/src/diagnostic-format.test.ts",
        "eliza/packages/app-core/platforms/electrobun/src/native/steward.test.ts",
        "eliza/packages/app-core/platforms/electrobun/src/application-menu.test.ts",
      ].filter((file) => fs.existsSync(path.join(repoRoot, file))),
    ],
  },
  ...chunkFiles("unit:app-tests", appTestFiles),
  ...chunkFiles("unit:lifeops-src", lifeOpsSourceTestFiles),
  ...chunkFiles("unit:apps-and-plugins-src", appsAndPluginsSourceTestFiles),
  ...chunkFiles("unit:workspace", workspaceTestFiles),
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
      "eliza/test/vitest/default.config.ts",
      "--reporter=dot",
      ...shard.patterns,
    ],
    cwd: repoRoot,
    env: unitEnv,
  });
}
