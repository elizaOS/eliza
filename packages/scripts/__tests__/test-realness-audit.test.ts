// Exercises tests test realness audit.test automation behavior with deterministic script fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    expect(markdown).toContain("| Mock-call-only assertion | report-only |");
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

    const result = Bun.spawnSync([
      "node",
      SCRIPT_PATH,
      "--repo-root",
      root,
      "--baseline",
      baselinePath,
      "--print-baseline",
    ]);

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(JSON.parse(stdout).thresholds.focusedOnly).toBe(0);
  });
});
