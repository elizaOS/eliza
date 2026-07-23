/**
 * Guards the Benchmark Bridge command against resolving its Vitest config
 * twice beneath the package root before any benchmark tests can run.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW_PATH = `${REPOSITORY_ROOT}/.github/workflows/benchmark-tests.yml`;

test("benchmark Vitest config is relative to its declared root", () => {
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
});
