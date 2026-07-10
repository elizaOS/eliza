#!/usr/bin/env node
/**
 * Regression checks for the changed-file enumerator the coverage gate consumes.
 * Each case builds a throwaway git repo whose history reproduces a real gate
 * hazard, runs the actual coverage-changed-files.sh against it, and asserts the
 * emitted GITHUB_OUTPUT sections. The two-dot regression (issue #15845) is
 * pinned by first proving a plain `BASE..HEAD` diff *would* drag a develop-side
 * file in, then asserting the script's three-dot diff does not.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const script = join(root, "scripts/security/coverage-changed-files.sh");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function write(cwd, relPath, contents) {
  const full = join(cwd, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

// Parse the `name<<EOF\n...\nEOF` heredoc blocks the script emits so assertions
// read against the same shape GitHub Actions stores into step outputs.
function parseOutput(stdout) {
  const sections = {};
  const lines = stdout.split("\n");
  let key = null;
  let buf = [];
  for (const line of lines) {
    if (key === null) {
      const m = line.match(/^(\w+)<<EOF$/);
      if (m) {
        key = m[1];
        buf = [];
      }
      continue;
    }
    if (line === "EOF") {
      sections[key] = buf.filter((l) => l !== "");
      key = null;
      continue;
    }
    buf.push(line);
  }
  return sections;
}

function runScript(cwd, base, head) {
  const result = spawnSync("bash", [script, base, head], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return parseOutput(result.stdout);
}

function assertCase(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const dir = mkdtempSync(join(tmpdir(), "coverage-changed-"));
try {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "checkout", "-q", "-b", "develop");

  // Merge-base commit: the point the feature branch forks from.
  write(dir, "packages/demo/src/base.ts", "export const base = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const mergeBase = git(dir, "rev-parse", "HEAD");

  // develop advances with a file the feature branch never touches.
  write(dir, "packages/demo/src/develop-only.ts", "export const d = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "develop advances");
  const developTip = git(dir, "rev-parse", "HEAD"); // BASE (event-time develop tip)

  // Feature branch forks from the merge-base and adds its own source + tests.
  git(dir, "checkout", "-q", "-b", "feature", mergeBase);
  write(dir, "packages/demo/src/feature.ts", "export const f = 1;\n");
  write(
    dir,
    "plugins/plugin-demo/vitest.config.ts",
    "export default { test: { include: ['scripts/**/*.test.mjs'] } };\n",
  );
  write(
    dir,
    "packages/demo/src/feature.test.ts",
    "import { test } from 'vitest';\ntest('f', () => {});\n",
  );
  write(
    dir,
    "packages/demo/src/native.test.ts",
    "import { test } from 'bun:test';\ntest('n', () => {});\n",
  );
  write(
    dir,
    "packages/demo/test/e2e/flow.test.ts",
    "import { test } from 'bun:test';\ntest('e2e', () => {});\n",
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feature work");
  const featureTip = git(dir, "rev-parse", "HEAD"); // HEAD

  const out = runScript(dir, developTip, featureTip);

  assertCase(
    "three-dot diff excludes develop-side files (issue #15845)",
    () => {
      // Prove the hazard is real: a plain two-dot diff would drag the develop-only
      // file into the changed set.
      const twoDot = git(
        dir,
        "diff",
        "--name-only",
        developTip,
        featureTip,
      ).split("\n");
      assert.ok(
        twoDot.includes("packages/demo/src/develop-only.ts"),
        "expected two-dot diff to include the develop-side file",
      );
      // The script uses three-dot, so it must not.
      assert.ok(
        !out.files.includes("packages/demo/src/develop-only.ts"),
        `develop-side file leaked into changed source: ${out.files.join(",")}`,
      );
      assert.ok(
        out.files.includes("packages/demo/src/feature.ts"),
        `feature source missing from changed set: ${out.files.join(",")}`,
      );
    },
  );

  assertCase(
    "e2e directory tests excluded from unit lanes (issue #15845)",
    () => {
      assert.ok(
        !out.bun_tests.includes("packages/demo/test/e2e/flow.test.ts"),
        `e2e-dir test leaked into bun lane: ${out.bun_tests.join(",")}`,
      );
      assert.ok(
        !out.vitest_tests.includes("packages/demo/test/e2e/flow.test.ts"),
        `e2e-dir test leaked into vitest lane: ${out.vitest_tests.join(",")}`,
      );
    },
  );

  assertCase("unit tests bucket by imported runner", () => {
    assert.ok(
      out.bun_tests.includes("packages/demo/src/native.test.ts"),
      `bun-native test missing: ${out.bun_tests.join(",")}`,
    );
    assert.ok(
      !out.bun_tests.includes("packages/demo/src/feature.test.ts"),
      "vitest test wrongly in bun lane",
    );
    assert.ok(
      out.vitest_tests.includes("packages/demo/src/feature.test.ts"),
      `vitest test missing: ${out.vitest_tests.join(",")}`,
    );
  });

  assertCase("vitest config changes are not LCOV-enforced source", () => {
    assert.ok(
      !out.files.includes("plugins/plugin-demo/vitest.config.ts"),
      `vitest config leaked into changed source: ${out.files.join(",")}`,
    );
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
