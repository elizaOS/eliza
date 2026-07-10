/** Exercises the plugin lane analyzer against deterministic temporary repositories. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const laneCoverage = await import(
  new URL("../lint-lane-coverage.mjs", import.meta.url).href
);

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-coverage-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(root, ".env.test.example"), "API_TOKEN=\n");
  return root;
}

function write(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writePlugin(root: string, name: string, packageExtra = {}) {
  write(
    root,
    `plugins/${name}/package.json`,
    JSON.stringify(
      {
        name: `@elizaos/${name}`,
        version: "0.0.0",
        type: "module",
        scripts: { test: "vitest run" },
        ...packageExtra,
      },
      null,
      2,
    ),
  );
}

describe("lint-lane-coverage analyzer", () => {
  test("accepts a plugin with unit, action, view, and deterministic e2e coverage", () => {
    const root = makeRepo();
    writePlugin(root, "plugin-covered", {
      scripts: { test: "vitest run", "build:views": "vite build" },
    });
    write(
      root,
      "plugins/plugin-covered/src/index.ts",
      "export default { actions: [coveredAction], views: [CoveredView] };",
    );
    write(
      root,
      "plugins/plugin-covered/src/actions/covered-action.test.ts",
      "import { test, expect } from 'vitest'; test('action', () => expect(true).toBe(true));",
    );
    write(
      root,
      "plugins/plugin-covered/src/views/CoveredView.test.tsx",
      "import { test, expect } from 'vitest'; test('view', () => expect(true).toBe(true));",
    );
    write(
      root,
      "plugins/plugin-covered/test/covered.e2e.test.ts",
      "import { test, expect } from 'vitest'; test('e2e', () => expect(true).toBe(true));",
    );

    const result = laneCoverage.analyzeLaneCoverage({
      repoRoot: root,
      allowlistPath: null,
    });

    expect(result.summary.pluginCount).toBe(1);
    expect(result.unsuppressedIssues).toEqual([]);
    expect(result.allowlistErrors).toEqual([]);
  });

  test("fails closed when a plugin has no tests or deterministic e2e coverage", () => {
    const root = makeRepo();
    writePlugin(root, "plugin-empty");
    write(
      root,
      "plugins/plugin-empty/src/index.ts",
      "export default { actions: [emptyAction], views: [EmptyView] };",
    );

    const result = laneCoverage.analyzeLaneCoverage({
      repoRoot: root,
      allowlistPath: null,
    });
    const codes = result.unsuppressedIssues.map(
      (entry: { code: string }) => entry.code,
    );

    expect(codes).toContain(laneCoverage.ISSUE_CODES.MISSING_TESTS);
    expect(codes).toContain(laneCoverage.ISSUE_CODES.MISSING_DETERMINISTIC_E2E);
    expect(codes).toContain(laneCoverage.ISSUE_CODES.MISSING_ACTION_TESTS);
    expect(codes).toContain(laneCoverage.ISSUE_CODES.MISSING_ACTION_E2E);
    expect(codes).toContain(laneCoverage.ISSUE_CODES.MISSING_VIEW_TESTS);
    expect(codes).toContain(laneCoverage.ISSUE_CODES.MISSING_VIEW_E2E);
  });

  test("does not invent action coverage gaps from empty action placeholders", () => {
    const root = makeRepo();
    writePlugin(root, "plugin-empty-actions");
    write(
      root,
      "plugins/plugin-empty-actions/src/index.ts",
      "export default { providers: [] };",
    );
    write(
      root,
      "plugins/plugin-empty-actions/src/actions/index.ts",
      "/** Messaging uses connector hooks instead of standalone actions. */\nexport {};",
    );
    write(
      root,
      "plugins/plugin-empty-actions/src/actions/connector-note.ts",
      "// The connector owns outbound messaging; no standalone action is registered.",
    );
    write(
      root,
      "plugins/plugin-empty-actions/src/plugin.test.ts",
      "import { test, expect } from 'vitest'; test('plugin', () => expect(true).toBe(true));",
    );

    const result = laneCoverage.analyzeLaneCoverage({
      repoRoot: root,
      allowlistPath: null,
    });
    const codes = result.unsuppressedIssues.map(
      (entry: { code: string }) => entry.code,
    );

    expect(codes).toContain(laneCoverage.ISSUE_CODES.MISSING_DETERMINISTIC_E2E);
    expect(codes).not.toContain(laneCoverage.ISSUE_CODES.MISSING_ACTION_TESTS);
    expect(codes).not.toContain(laneCoverage.ISSUE_CODES.MISSING_ACTION_E2E);
  });

  test("keeps executable action modules in the action-surface inventory", () => {
    const root = makeRepo();
    writePlugin(root, "plugin-handler-action");
    write(
      root,
      "plugins/plugin-handler-action/src/index.ts",
      "export default { providers: [] };",
    );
    write(
      root,
      "plugins/plugin-handler-action/src/actions/handler.ts",
      "export async function runAction() { return { success: true }; }",
    );
    write(
      root,
      "plugins/plugin-handler-action/src/plugin.test.ts",
      "import { test, expect } from 'vitest'; test('plugin', () => expect(true).toBe(true));",
    );

    const result = laneCoverage.analyzeLaneCoverage({
      repoRoot: root,
      allowlistPath: null,
    });
    const codes = result.unsuppressedIssues.map(
      (entry: { code: string }) => entry.code,
    );

    expect(codes).toContain(laneCoverage.ISSUE_CODES.MISSING_ACTION_TESTS);
    expect(codes).toContain(laneCoverage.ISSUE_CODES.MISSING_ACTION_E2E);
  });

  test("requires explicit allowlist reasons and treats stale entries as errors", () => {
    const root = makeRepo();
    writePlugin(root, "plugin-allowlisted");
    write(
      root,
      "plugins/plugin-allowlisted/src/index.ts",
      "export default { providers: [] };",
    );
    write(
      root,
      "plugins/plugin-allowlisted/src/provider.test.ts",
      "import { test, expect } from 'vitest'; test('provider', () => expect(true).toBe(true));",
    );
    write(
      root,
      "allowlist.json",
      JSON.stringify({
        entries: [
          {
            plugin: "plugin-allowlisted",
            issues: [laneCoverage.ISSUE_CODES.MISSING_DETERMINISTIC_E2E],
            reason: "tracked as fixture debt",
          },
        ],
      }),
    );

    const suppressed = laneCoverage.analyzeLaneCoverage({
      repoRoot: root,
      allowlistPath: path.join(root, "allowlist.json"),
    });

    expect(suppressed.unsuppressedIssues).toEqual([]);
    expect(suppressed.suppressedIssues).toHaveLength(1);
    expect(suppressed.allowlistErrors).toEqual([]);

    write(
      root,
      "allowlist.json",
      JSON.stringify({
        entries: [
          {
            plugin: "plugin-allowlisted",
            issues: [laneCoverage.ISSUE_CODES.MISSING_TESTS],
            reason: "stale fixture",
          },
        ],
      }),
    );

    const stale = laneCoverage.analyzeLaneCoverage({
      repoRoot: root,
      allowlistPath: path.join(root, "allowlist.json"),
    });

    expect(stale.allowlistErrors).toContainEqual(
      expect.stringContaining("unused entry plugin-allowlisted:missing-tests"),
    );
  });
});
