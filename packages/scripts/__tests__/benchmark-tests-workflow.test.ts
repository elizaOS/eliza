/** Pins the LifeOps benchmark bridge commands to paths Vitest resolves from its configured root. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../../.github/workflows/benchmark-tests.yml", import.meta.url),
  "utf8",
);

describe("Benchmark Bridge Tests workflow", () => {
  test("resolves the Vitest config once from the package root", () => {
    expect(workflow).toContain(
      "bunx vitest run --config vitest.config.ts --root packages/lifeops-bench --passWithNoTests",
    );
    expect(workflow).not.toContain(
      "--config packages/lifeops-bench/vitest.config.ts --root packages/lifeops-bench",
    );
  });

  test("keeps formatting as an independent matrix lane", () => {
    expect(workflow).toContain(
      "bunx @biomejs/biome check packages/lifeops-bench/src",
    );
  });
});
