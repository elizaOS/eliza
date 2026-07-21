import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveWorkspacePackageDirs } from "../lib/workspace-package-dirs.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function packageDir(root: string, relative: string) {
  const dir = path.join(root, relative);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), "{}\n");
}

describe("resolveWorkspacePackageDirs", () => {
  test("finds every declared nested workspace without including undeclared manifests", () => {
    const root = path.join(
      tmpdir(),
      `eliza-workspaces-${process.pid}-${Date.now()}`,
    );
    roots.push(root);
    packageDir(root, "packages/top");
    packageDir(root, "packages/cloud/api");
    packageDir(root, "packages/cloud/api/nested-template");

    const actual = resolveWorkspacePackageDirs(root, [
      "packages/*",
      "packages/cloud/*",
    ]).map((dir) => path.relative(root, dir));

    expect(actual).toEqual(["packages/cloud/api", "packages/top"]);
  });

  test("honors exclusions before later explicit nested inclusions", () => {
    const root = path.join(
      tmpdir(),
      `eliza-workspaces-${process.pid}-${Date.now()}`,
    );
    roots.push(root);
    packageDir(root, "packages/feed");
    packageDir(root, "packages/feed/packages/core");

    const actual = resolveWorkspacePackageDirs(root, [
      "packages/*",
      "!packages/feed",
      "packages/feed/packages/*",
    ]).map((dir) => path.relative(root, dir));

    expect(actual).toEqual(["packages/feed/packages/core"]);
  });
});
