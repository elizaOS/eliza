/** Exercise the actual selector against committed fixture workspaces and Git history. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const source = import.meta.dirname;
test("CI selection preserves complete Git changes and dynamic plugin scenarios", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-affected-integration-"));
  const env = { ...process.env, GITHUB_SHA: "HEAD", GITHUB_OUTPUT: "" };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", env });
  const write = (file: string, value: unknown) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(
      path.join(root, file),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=CI fixture",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD").trim();
  };
  const select = (base: string) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["packages/scripts/ci-affected.ts", base],
        { cwd: root, encoding: "utf8", env },
      ),
    ).outputs;
  try {
    git("init", "-q");
    for (const file of [
      "ci-affected.ts",
      "lib/workspaces.ts",
      "lib/repository-file-integrity.ts",
    ]) {
      const target = path.join(root, "packages/scripts", file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(source, file), target);
    }
    write("package.json", {
      type: "module",
      workspaces: ["packages/*", "plugins/*"],
    });
    write("plugins/plugin-form/package.json", { name: "@fixture/form" });
    write("packages/core/package.json", { name: "@fixture/core" });
    write("packages/app/package.json", {
      name: "@fixture/app",
      dependencies: { "@fixture/core": "workspace:*" },
    });
    const base = commit();
    write("README.md", "Fixture docs\n");
    commit();
    assert.equal(select(base).source, "false");
    write("plugins/plugin-form/index.ts", "export const form = true;\n");
    const pluginHead = commit();
    assert.equal(
      select(base).scenarios,
      "true",
      "catalog-loaded plugins need scenario coverage",
    );
    write("packages/core/index.ts", "export const core = true;\n");
    commit();
    assert.equal(
      select(pluginHead).app,
      "true",
      "reverse dependencies must run",
    );
    write("README.md", "Another docs commit after unvalidated source\n");
    commit();
    assert.equal(
      select(base).app,
      "true",
      "all changes since the validated ancestor must count",
    );
    assert.equal(select("0".repeat(40)).full, "true");
    assert.equal(select("a".repeat(40)).full, "true");
    const current = git("rev-parse", "HEAD").trim();
    write("unowned/source.ts", "export {};\n");
    commit();
    assert.equal(
      select(current).full,
      "true",
      "unknown source must select everything",
    );
    const beforeRename = git("rev-parse", "HEAD").trim();
    git("mv", "plugins/plugin-form", "retired-form");
    commit();
    assert.equal(
      select(beforeRename).full,
      "true",
      "renamed workspaces must not disappear",
    );
    assert.equal(select(git("rev-parse", "HEAD").trim()).source, "false");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
