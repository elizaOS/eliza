/** Verifies dist-path discovery stays inside the active repository checkout. */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { findDistPathConsumerConfigs } from "../typecheck-dist-path-consumers.mjs";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function writeConfig(configPath, extendsValue) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ extends: extendsValue }));
}

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "dist-path-consumers-"));
  fixtures.push(root);
  git(root, "init", "--quiet");
  writeFileSync(join(root, "tsconfig.dist-paths.json"), "{}");
  return root;
}

function relativeConsumers(root) {
  return findDistPathConsumerConfigs(root).map((config) =>
    relative(root, config),
  );
}

describe("dist-path consumer discovery", () => {
  test("ignores known root worktrees and build artifact directories", () => {
    const root = makeRepo();
    writeConfig(
      join(root, "packages", "active", "tsconfig.json"),
      "../../tsconfig.dist-paths.json",
    );
    for (const worktreeDir of [
      ".worktrees",
      ".audit-worktrees",
      ".codex-agent-worktrees",
      ".codex-pr-worktrees",
      ".codex-worktrees",
    ]) {
      writeConfig(
        join(root, worktreeDir, "other", "tsconfig.json"),
        "../../tsconfig.dist-paths.json",
      );
    }
    writeConfig(
      join(root, "vendor", "copied", "tsconfig.json"),
      "../../tsconfig.dist-paths.json",
    );
    writeConfig(
      join(
        root,
        "packages",
        ".codex-agent-worktrees",
        "visible",
        "tsconfig.json",
      ),
      "../../../tsconfig.dist-paths.json",
    );

    expect(relativeConsumers(root)).toEqual([
      join("packages", ".codex-agent-worktrees", "visible", "tsconfig.json"),
      join("packages", "active", "tsconfig.json"),
    ]);
  });

  test("arbitrary nested Git markers cannot hide first-party configs", () => {
    const root = makeRepo();
    writeConfig(
      join(root, "packages", "gitfile", "tsconfig.json"),
      "../../tsconfig.dist-paths.json",
    );
    writeFileSync(
      join(root, "packages", "gitfile", ".git"),
      "gitdir: ../../../.git/modules/packages/gitfile\n",
    );
    writeConfig(
      join(root, "packages", "gitdir", "tsconfig.json"),
      "../../tsconfig.dist-paths.json",
    );
    mkdirSync(join(root, "packages", "gitdir", ".git"));

    expect(relativeConsumers(root)).toEqual([
      join("packages", "gitdir", "tsconfig.json"),
      join("packages", "gitfile", "tsconfig.json"),
    ]);
  });

  test("a declaration without an indexed gitlink cannot hide a config", () => {
    const root = makeRepo();
    writeFileSync(
      join(root, ".gitmodules"),
      [
        '[submodule "first-party"]',
        "  path = plugins/first-party",
        "  url = https://example.test/first-party.git",
      ].join("\n"),
    );
    writeConfig(
      join(root, "plugins", "first-party", "tsconfig.json"),
      "../../tsconfig.dist-paths.json",
    );

    expect(relativeConsumers(root)).toEqual([
      join("plugins", "first-party", "tsconfig.json"),
    ]);
  });

  test("only skips a submodule when its declaration and gitlink agree", () => {
    const root = makeRepo();
    const upstreamRoot = join(root, "plugins", "upstream");
    writeConfig(
      join(upstreamRoot, "tsconfig.json"),
      "../../tsconfig.dist-paths.json",
    );
    git(upstreamRoot, "init", "--quiet");
    git(upstreamRoot, "add", "tsconfig.json");
    git(
      upstreamRoot,
      "-c",
      "user.name=Test Fixture",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    const upstreamCommit = git(upstreamRoot, "rev-parse", "HEAD");

    git(
      root,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${upstreamCommit},plugins/upstream`,
    );
    rmSync(join(upstreamRoot, ".git"), { recursive: true, force: true });

    expect(relativeConsumers(root)).toEqual([
      join("plugins", "upstream", "tsconfig.json"),
    ]);

    writeFileSync(
      join(root, ".gitmodules"),
      [
        '[submodule "upstream"]',
        "  path = plugins/upstream",
        "  url = https://example.test/upstream.git",
      ].join("\n"),
    );
    git(root, "add", ".gitmodules");

    expect(relativeConsumers(root)).toEqual([]);
  });
});
