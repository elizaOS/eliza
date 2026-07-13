// Exercises tests test realness audit.test automation behavior with deterministic script fixtures.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const audit = await import(
  new URL("../test-realness-audit.mjs", import.meta.url).href
);

const SCRIPT_PATH = fileURLToPath(
  new URL("../test-realness-audit.mjs", import.meta.url),
);

const tempRoots: string[] = [];
const focusedSuffix = "." + "on" + "ly";
const todoSuffix = "." + "to" + "do";
const xit = "x" + "it";

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-realness-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, "packages", "sample"), { recursive: true });
  return root;
}

function write(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("test-realness-audit", () => {
  test("focused .only is a hard failure, including chained-modifier forms", () => {
    const root = makeRepo();
    write(
      root,
      "packages/sample/focused.test.ts",
      [
        "import { describe, test } from 'vitest';",
        `describe${focusedSuffix}('focused', () => {`,
        "  test('runs alone', () => {});",
        "});",
        `describe.sequential${focusedSuffix}('chained focus', () => {`,
        "  test('also runs alone', () => {});",
        "});",
      ].join("\n"),
    );

    const result = audit.scanTestRealness({ repoRoot: root });
    expect(result.summary.byCategory.focusedOnly).toBe(2);

    const failures = audit.collectFailures(result);
    expect(failures).toContain("focusedOnly must stay at 0, found 2");
  });

  test("todo and x-disabled tests are enforced at zero, tracked or not", () => {
    const root = makeRepo();
    write(
      root,
      "packages/sample/disabled.test.ts",
      [
        "import { describe, it } from 'vitest';",
        "// TODO(#10718) tracked but still a phantom test entry.",
        `it${todoSuffix}('tracked todo', () => {});`,
        `${xit}('x-disabled test', () => {});`,
      ].join("\n"),
    );

    const result = audit.scanTestRealness({ repoRoot: root });
    expect(result.summary.byCategory.todoTest).toBe(1);
    expect(result.summary.byCategory.xSkippedTest).toBe(1);

    const failures = audit.collectFailures(result);
    expect(failures).toContain("todoTest must stay at 0, found 1");
    expect(failures).toContain("xSkippedTest must stay at 0, found 1");
  });

  test("report-only categories are inventoried but never fail the gate", () => {
    const root = makeRepo();
    write(
      root,
      "packages/sample/skips.test.ts",
      [
        "import { expect, it, vi } from 'vitest';",
        "// #10718 tracked while the live account lane is provisioned.",
        "it.skip('tracked skip', () => {});",
        "",
        "",
        "",
        "",
        "it.skip('untracked skip', () => {});",
        "if (!process.env.LIVE_TOKEN) {",
        "  return;",
        "}",
        "it('mock-call assertion', () => {",
        "  const mockThing = vi.fn();",
        "  expect(true).toBe(true);",
        "  expect(mockThing).toHaveBeenCalled();",
        "});",
      ].join("\n"),
    );

    const result = audit.scanTestRealness({ repoRoot: root });
    expect(result.summary.byCategory.skippedTest).toBe(2);
    expect(result.summary.byCategory.envEarlyReturn).toBe(1);
    expect(result.summary.byCategory.envConditionalSuite).toBe(1);
    expect(result.summary.byCategory.tautologicalAssertion).toBe(1);
    expect(result.summary.byCategory.mockCallOnlyAssertion).toBe(1);
    expect(result.summary.untrackedSkips).toBe(3);

    expect(audit.collectFailures(result)).toEqual([]);
  });

  test("mock-only and tautological assertions fail only when touched files increase", () => {
    const root = makeRepo();
    const relPath = "packages/sample/weak.test.ts";
    const baseFindings = audit.analyzeTestSource(
      root,
      relPath,
      [
        "import { expect, test } from 'vitest';",
        "test('real outcome', () => {",
        "  expect(2 + 2).toBe(4);",
        "});",
      ].join("\n"),
    );
    const currentFindings = audit.analyzeTestSource(
      root,
      relPath,
      [
        "import { expect, test, vi } from 'vitest';",
        "test('weak outcome', () => {",
        "  const mockThing = vi.fn();",
        "  expect(true).toBe(true);",
        "  expect(mockThing).toHaveBeenCalled();",
        "});",
      ].join("\n"),
    );

    const regressions = audit.collectDiffScopedRegressions({
      currentFindings,
      baseFindings,
      changedFiles: [relPath],
    });

    expect(regressions).toEqual([
      {
        file: relPath,
        category: "mockCallOnlyAssertion",
        current: 1,
        base: 0,
      },
      {
        file: relPath,
        category: "tautologicalAssertion",
        current: 1,
        base: 0,
      },
    ]);
    expect(audit.collectDiffScopedFailures(regressions)).toContain(
      "mockCallOnlyAssertion increased in touched test file packages/sample/weak.test.ts: 1 current > 0 base",
    );
  });

  test("internal runtime mocks are diff-scoped migration debt", () => {
    const root = makeRepo();
    const relPath = "packages/sample/runtime.test.ts";
    const baseFindings = audit.analyzeTestSource(
      root,
      relPath,
      "import { test } from 'vitest';\ntest('real runtime', () => {});\n",
    );
    const currentFindings = audit.analyzeTestSource(
      root,
      relPath,
      [
        "import { createMockRuntime } from '../testing/mock-runtime';",
        "import { test } from 'vitest';",
        "test('synthetic runtime', () => {",
        "  const runtime = createMockRuntime();",
        "  void runtime;",
        "});",
      ].join("\n"),
    );

    expect(currentFindings).toContainEqual(
      expect.objectContaining({
        category: "internalRuntimeMock",
        path: relPath,
        line: 4,
      }),
    );
    const regressions = audit.collectDiffScopedRegressions({
      currentFindings,
      baseFindings,
      changedFiles: [relPath],
    });
    expect(audit.collectDiffScopedFailures(regressions)).toContain(
      "internalRuntimeMock increased in touched test file packages/sample/runtime.test.ts: 1 current > 0 base",
    );
  });

  test("partial objects cast to IAgentRuntime are diff-scoped migration debt", () => {
    const root = makeRepo();
    const relPath = "packages/sample/cast-runtime.test.ts";
    const currentFindings = audit.analyzeTestSource(
      root,
      relPath,
      [
        "import type { IAgentRuntime } from '@elizaos/core';",
        "const runtime = { agentId: 'fake' } as unknown as IAgentRuntime;",
        "void runtime;",
      ].join("\n"),
    );

    expect(currentFindings).toContainEqual(
      expect.objectContaining({
        category: "internalRuntimeCast",
        path: relPath,
        line: 2,
      }),
    );
    const regressions = audit.collectDiffScopedRegressions({
      currentFindings,
      baseFindings: [],
      changedFiles: [relPath],
    });
    expect(audit.collectDiffScopedFailures(regressions)).toContain(
      "internalRuntimeCast increased in touched test file packages/sample/cast-runtime.test.ts: 1 current > 0 base",
    );
  });

  test("real-outcome assertions do not trigger the diff-scoped ratchet", () => {
    const root = makeRepo();
    const relPath = "packages/sample/real.test.ts";
    const baseFindings = audit.analyzeTestSource(
      root,
      relPath,
      "import { test } from 'vitest';\ntest('placeholder', () => {});\n",
    );
    const currentFindings = audit.analyzeTestSource(
      root,
      relPath,
      [
        "import { expect, test } from 'vitest';",
        "test('real outcome', () => {",
        "  const result = 2 + 2;",
        "  expect(result).toBe(4);",
        "});",
      ].join("\n"),
    );

    expect(
      audit.collectDiffScopedRegressions({
        currentFindings,
        baseFindings,
        changedFiles: [relPath],
      }),
    ).toEqual([]);
  });

  test("--check fails closed when the diff-scoped base cannot be resolved", () => {
    const root = makeRepo();
    write(
      root,
      "packages/sample/plain.test.ts",
      "import { test } from 'vitest';\ntest('plain', () => {});\n",
    );

    const result = spawnSync(
      "node",
      [SCRIPT_PATH, "--repo-root", root, "--check"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("diff-scoped ratchet could not run");
    expect(result.stderr).toContain("Ensure CI fetches origin/develop");
  });

  test("comments do not register as focused tests", () => {
    const root = makeRepo();
    write(
      root,
      "packages/sample/commented.test.ts",
      [
        "import { test } from 'vitest';",
        `// describe${focusedSuffix}('not real', () => {});`,
        `/* it${focusedSuffix}('also not real', () => {}); */`,
        "test('plain', () => {});",
      ].join("\n"),
    );

    const result = audit.scanTestRealness({ repoRoot: root });
    expect(result.summary.byCategory.focusedOnly).toBe(0);
  });

  test("report labels categories with their enforcement mode and deltas", () => {
    const root = makeRepo();
    write(
      root,
      "packages/sample/weak.test.ts",
      [
        "import { expect, test, vi } from 'vitest';",
        "test('weak', () => {",
        "  const mockThing = vi.fn();",
        "  expect(true).toBe(true);",
        "  expect(mockThing).toHaveBeenCalled();",
        "});",
      ].join("\n"),
    );

    const result = audit.scanTestRealness({ repoRoot: root });
    const baseline = { thresholds: { tautologicalAssertion: 0 } };
    const markdown = audit.buildMarkdownReport(
      result,
      baseline,
      audit.collectFailures(result),
    );

    expect(markdown).toContain("Tautological assertion");
    expect(markdown).toContain("Mock-call-only assertion");
    expect(markdown).toContain("| Focused .only test | enforced |");
    expect(markdown).toContain("| Mock-call-only assertion | diff-scoped |");
    expect(markdown).toContain("packages/sample/weak.test.ts:4");
    expect(markdown).toContain("Gate status: **pass**");
  });

  test("--print-baseline does not read an existing truncated baseline", () => {
    const root = makeRepo();
    write(
      root,
      "packages/sample/plain.test.ts",
      "import { test } from 'vitest';\ntest('plain', () => {});\n",
    );
    const baselinePath = path.join(root, "empty-baseline.json");
    fs.writeFileSync(baselinePath, "");

    const result = spawnSync(
      "node",
      [
        SCRIPT_PATH,
        "--repo-root",
        root,
        "--baseline",
        baselinePath,
        "--print-baseline",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).thresholds.focusedOnly).toBe(0);
  });
});
