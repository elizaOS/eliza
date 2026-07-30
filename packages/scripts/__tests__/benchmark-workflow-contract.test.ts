/**
 * Guards the Benchmark Bridge lane's package root and complete workspace build boundary.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW_PATH = `${REPOSITORY_ROOT}/.github/workflows/benchmark-tests.yml`;

test("benchmark lane builds its dependency closure and uses its package root", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");

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
    "bunx turbo run build --filter=@elizaos/lifeops-bench...",
  );
});
