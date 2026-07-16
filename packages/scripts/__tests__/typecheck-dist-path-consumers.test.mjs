/** Verifies dist-path discovery stays inside the active repository checkout. */

import { afterEach, describe, expect, test } from "bun:test";
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

describe("dist-path consumer discovery", () => {
  test("ignores nested Git checkouts and build artifact directories", () => {
    const root = mkdtempSync(join(tmpdir(), "dist-path-consumers-"));
    fixtures.push(root);
    const distConfig = join(root, "tsconfig.dist-paths.json");
    writeFileSync(distConfig, "{}");

    writeConfig(
      join(root, "packages", "active", "tsconfig.json"),
      "../../tsconfig.dist-paths.json",
    );
    writeConfig(
      join(root, ".codex-agent-worktrees", "other", "tsconfig.json"),
      "../../tsconfig.dist-paths.json",
    );
    writeFileSync(
      join(root, ".codex-agent-worktrees", "other", ".git"),
      "gitdir: elsewhere",
    );
    writeConfig(
      join(root, "vendor", "copied", "tsconfig.json"),
      "../../tsconfig.dist-paths.json",
    );

    expect(
      findDistPathConsumerConfigs(root, distConfig).map((config) =>
        relative(root, config),
      ),
    ).toEqual([join("packages", "active", "tsconfig.json")]);
  });
});
