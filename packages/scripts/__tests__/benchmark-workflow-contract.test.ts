/**
 * Guards the Benchmark Bridge lane's triggers, package root, and workspace build boundary.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW_PATH = `${REPOSITORY_ROOT}/.github/workflows/benchmark-tests.yml`;

test("benchmark lane covers develop dependency changes and builds its dependency closure", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");

  expect(workflow).toContain("pull_request:\n    branches: [main, develop]");
  for (const dependencyPath of [
    "plugins/plugin-personal-assistant/**",
    "packages/agent/**",
    "packages/app-core/test/helpers/**",
    "packages/core/**",
    "packages/shared/**",
    "package.json",
    "bun.lock",
    "turbo.json",
    "tsconfig*.json",
    ".github/actions/setup-bun-workspace/**",
  ]) {
    expect(workflow).toContain(`- "${dependencyPath}"`);
  }
  expect(workflow).toContain(
    "bunx vitest run --config vitest.config.ts --root packages/lifeops-bench --passWithNoTests",
  );
  expect(workflow).not.toContain(
    "--config packages/lifeops-bench/vitest.config.ts --root packages/lifeops-bench",
  );
  expect(workflow).toContain(
    "node packages/app-core/scripts/ensure-shared-i18n-data.mjs",
  );
  expect(workflow).toMatch(/if: \$\{\{ matrix\.lane == 'benchmark-tests' \}\}/);
  expect(workflow).toContain(
    "bunx turbo run build --filter=@elizaos/lifeops-bench",
  );
  expect(workflow).not.toContain(
    "bunx turbo run build --filter=@elizaos/lifeops-bench...",
  );
});
