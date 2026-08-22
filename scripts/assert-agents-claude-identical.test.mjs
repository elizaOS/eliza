/**
 * Exercises guide-pair filtering and real sparse-checkout behavior through the
 * repository checker process.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { shouldCheckGuideFile } from "./assert-agents-claude-identical.mjs";

const checkerPath = fileURLToPath(
  new URL("./assert-agents-claude-identical.mjs", import.meta.url),
);

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
}

function createSparseRepository({ divergentNestedPair = false } = {}) {
  const repository = mkdtempSync(join(tmpdir(), "eliza-guide-parity-"));
  mkdirSync(join(repository, "kept"), { recursive: true });
  mkdirSync(join(repository, "packages", "example"), { recursive: true });

  writeFileSync(join(repository, "AGENTS.md"), "root guide\n");
  writeFileSync(join(repository, "CLAUDE.md"), "root guide\n");
  writeFileSync(join(repository, "kept", "README.md"), "sparse cone\n");
  writeFileSync(
    join(repository, "packages", "example", "AGENTS.md"),
    divergentNestedPair ? "agents guide\n" : "nested guide\n",
  );
  writeFileSync(
    join(repository, "packages", "example", "CLAUDE.md"),
    divergentNestedPair ? "claude guide\n" : "nested guide\n",
  );

  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "Guide Test"]);
  git(repository, ["config", "user.email", "guide-test@example.invalid"]);
  git(repository, ["config", "core.autocrlf", "false"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "seed guide pairs"]);
  git(repository, ["sparse-checkout", "init", "--cone"]);
  git(repository, ["sparse-checkout", "set", "kept"]);

  assert.equal(existsSync(join(repository, "AGENTS.md")), true);
  assert.equal(
    existsSync(join(repository, "packages", "example", "AGENTS.md")),
    false,
  );
  return repository;
}

function runChecker(repository) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: repository,
    encoding: "utf8",
  });
}

describe("assert-agents-claude-identical guide filtering", () => {
  it("checks authored guide pairs", () => {
    assert.equal(shouldCheckGuideFile("AGENTS.md"), true);
    assert.equal(shouldCheckGuideFile("CLAUDE.md"), true);
    assert.equal(shouldCheckGuideFile("packages/app/AGENTS.md"), true);
    assert.equal(shouldCheckGuideFile("plugins/plugin-openai/CLAUDE.md"), true);
  });

  it("excludes fixture, test, and archived sample trees", () => {
    assert.equal(
      shouldCheckGuideFile(
        "packages/elizaos/src/migrate/__tests__/fixtures/oc-home/AGENTS.md",
      ),
      false,
    );
    assert.equal(
      shouldCheckGuideFile(
        "packages/elizaos/src/migrate/__tests__/fixtures/oc-home/CLAUDE.md",
      ),
      false,
    );
  });
});

describe("assert-agents-claude-identical sparse checkout coverage", () => {
  it("audits byte-identical guide pairs omitted from the worktree", () => {
    const repository = createSparseRepository();
    try {
      const result = runChecker(repository);
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        /PASS: 2 tracked CLAUDE\.md\/AGENTS\.md pair/,
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("fails on a divergent pair omitted from the worktree", () => {
    const repository = createSparseRepository({ divergentNestedPair: true });
    try {
      const result = runChecker(repository);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /packages[\\/]example: CLAUDE\.md and AGENTS\.md differ/,
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("keeps checked-out worktree edits authoritative", () => {
    const repository = createSparseRepository();
    try {
      writeFileSync(join(repository, "AGENTS.md"), "modified worktree guide\n");
      const result = runChecker(repository);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /\.: CLAUDE\.md and AGENTS\.md differ/);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("fails when an ordinary tracked guide is deleted", () => {
    const repository = createSparseRepository();
    try {
      rmSync(join(repository, "AGENTS.md"));
      const result = runChecker(repository);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /tracked guide missing from working tree: AGENTS\.md/,
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
