/**
 * Unit + live-repo-parity tests for the workspace/submodule discovery seam
 * (packages/scripts/lib/workspaces.mjs). Synthetic cases exercise glob
 * semantics against throwaway temp trees; parity cases assert the lib agrees
 * with the real repo's package.json and .gitmodules. Deterministic, no network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectWorkspaceMaps } from "../../app-core/scripts/lib/workspace-discovery.mjs";
import {
  expandWorkspaceGlobs,
  listPackages,
  listSubmodules,
  listWorkspaceDirs,
} from "../lib/workspaces.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspaces-lib-"));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writePackage(root: string, dir: string, name?: string): void {
  writeFile(
    root,
    path.join(dir, "package.json"),
    JSON.stringify(name ? { name } : {}, null, 2),
  );
}

function writeRootPackage(root: string, workspaces: string[]): void {
  writeFile(
    root,
    "package.json",
    JSON.stringify({ type: "module", workspaces }, null, 2),
  );
}

describe("expandWorkspaceGlobs — glob semantics", () => {
  test("simple `*` matches one segment of directories", () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, "packages/a"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/b"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/a/nested"), { recursive: true });

    const dirs = expandWorkspaceGlobs(["packages/*"], { repoRoot: root });
    expect(dirs).toEqual(["packages/a", "packages/b"]);
  });

  test("nested `*/*` matches exactly two segments deep", () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, "packages/group/one"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/group/two"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/solo"), { recursive: true });

    const dirs = expandWorkspaceGlobs(["packages/*/*"], { repoRoot: root });
    expect(dirs).toEqual(["packages/group/one", "packages/group/two"]);
  });

  test("`**` matches any depth including the base directory", () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, "packages/a/deep/deeper"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, "packages/b"), { recursive: true });

    const dirs = expandWorkspaceGlobs(["packages/**"], { repoRoot: root });
    expect(dirs).toEqual([
      "packages",
      "packages/a",
      "packages/a/deep",
      "packages/a/deep/deeper",
      "packages/b",
    ]);
  });

  test("`*` skips hidden and build-output dirs (e.g. a stray `.next` marker)", () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, "examples/real"), { recursive: true });
    // A Next.js build dir carries a `{"type":"commonjs"}` package.json marker;
    // it is not a workspace member and must not be matched by a `*` segment.
    fs.mkdirSync(path.join(root, "examples/real/.next"), { recursive: true });
    fs.mkdirSync(path.join(root, "examples/real/dist"), { recursive: true });

    expect(expandWorkspaceGlobs(["examples/*"], { repoRoot: root })).toEqual([
      "examples/real",
    ]);
    expect(expandWorkspaceGlobs(["examples/*/*"], { repoRoot: root })).toEqual(
      [],
    );
  });

  test("negation subtracts an earlier match (exclude-wins)", () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, "packages/keep"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/feed"), { recursive: true });

    const dirs = expandWorkspaceGlobs(["packages/*", "!packages/feed"], {
      repoRoot: root,
    });
    expect(dirs).toEqual(["packages/keep"]);
  });

  test("later positive pattern re-adds a previously negated dir (last-match-wins)", () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, "packages/feed"), { recursive: true });

    const dirs = expandWorkspaceGlobs(
      ["packages/*", "!packages/feed", "packages/feed"],
      { repoRoot: root },
    );
    expect(dirs).toEqual(["packages/feed"]);
  });
});

describe("listWorkspaceDirs — package.json filtering", () => {
  test("keeps only directories that contain a package.json", () => {
    const root = makeRepo();
    writeRootPackage(root, ["packages/*"]);
    writePackage(root, "packages/real", "@x/real");
    fs.mkdirSync(path.join(root, "packages/empty"), { recursive: true });

    expect(listWorkspaceDirs({ repoRoot: root })).toEqual(["packages/real"]);
  });

  test("hidden and build dirs are skipped by `**` traversal", () => {
    const root = makeRepo();
    writeRootPackage(root, ["packages/**"]);
    writePackage(root, "packages", "@x/packages-root");
    writePackage(root, "packages/live", "@x/live");
    writePackage(root, "packages/live/node_modules/dep", "dep");
    writePackage(root, "packages/live/dist", "dist-pkg");
    writePackage(root, "packages/.hidden", "hidden-pkg");

    expect(listWorkspaceDirs({ repoRoot: root })).toEqual([
      "packages",
      "packages/live",
    ]);
  });

  test("negation excludes a workspace with a package.json", () => {
    const root = makeRepo();
    writeRootPackage(root, ["packages/*", "!packages/feed"]);
    writePackage(root, "packages/core", "@x/core");
    writePackage(root, "packages/feed", "@x/feed");

    expect(listWorkspaceDirs({ repoRoot: root })).toEqual(["packages/core"]);
  });

  test("a non-file workspace manifest is an error, not an absent package", () => {
    const root = makeRepo();
    writeRootPackage(root, ["packages/*"]);
    fs.mkdirSync(path.join(root, "packages/broken/package.json"), {
      recursive: true,
    });
    expect(() => listWorkspaceDirs({ repoRoot: root })).toThrow(
      "Workspace manifest is not a file",
    );
  });
});

describe("listPackages — name mapping", () => {
  test("maps each workspace dir to { name, dir, packageJson }", () => {
    const root = makeRepo();
    writeRootPackage(root, ["packages/*"]);
    writePackage(root, "packages/alpha", "@x/alpha");
    writePackage(root, "packages/beta");

    const packages = listPackages({ repoRoot: root });
    expect(packages).toEqual([
      {
        name: "@x/alpha",
        dir: "packages/alpha",
        packageJson: { name: "@x/alpha" },
      },
      { name: undefined, dir: "packages/beta", packageJson: {} },
    ]);
  });

  test("malformed intended manifests fail discovery instead of disappearing", () => {
    const root = makeRepo();
    writeRootPackage(root, ["packages/*"]);
    writeFile(root, "packages/broken/package.json", "{broken");
    expect(() => listPackages({ repoRoot: root })).toThrow("Invalid JSON in");
  });

  test("duplicate package names fail instead of overwriting a resolver map", () => {
    const root = makeRepo();
    writeRootPackage(root, ["packages/*"]);
    writePackage(root, "packages/a", "@x/duplicate");
    writePackage(root, "packages/b", "@x/duplicate");
    expect(() => listPackages({ repoRoot: root })).toThrow(
      "Duplicate workspace package name",
    );
  });

  test("app-core compatibility uses the same resolver and absolute maps", () => {
    const root = makeRepo();
    writeRootPackage(root, ["packages/*"]);
    writePackage(root, "packages/a", "@x/a");
    const maps = collectWorkspaceMaps(root, ["packages/*"]);
    expect(maps.nameToDir.get("@x/a")).toBe(path.join(root, "packages/a"));
    expect(maps.workspaceDirs).toContain(path.join(root, "packages/a"));
  });
});

describe("listSubmodules — .gitmodules parsing", () => {
  test("parses path/url/branch and marks initialization state", () => {
    const root = makeRepo();
    writeFile(
      root,
      ".gitmodules",
      [
        '[submodule "vendor/checked-out"]',
        "\t# a comment line that must be ignored",
        "\tpath = vendor/checked-out",
        "\turl = https://example.com/a.git",
        "\tbranch = main",
        "",
        '[submodule "vendor/placeholder"]',
        "\tpath = vendor/placeholder",
        "\turl = https://example.com/b.git",
        "",
      ].join("\n"),
    );
    writeFile(root, "vendor/checked-out/.git", "gitdir: ../../.git/modules/x");
    fs.mkdirSync(path.join(root, "vendor/placeholder"), { recursive: true });

    expect(listSubmodules({ repoRoot: root })).toEqual([
      {
        path: "vendor/checked-out",
        url: "https://example.com/a.git",
        branch: "main",
        initialized: true,
      },
      {
        path: "vendor/placeholder",
        url: "https://example.com/b.git",
        branch: undefined,
        initialized: false,
      },
    ]);
  });

  test("returns an empty list when .gitmodules is absent", () => {
    const root = makeRepo();
    expect(listSubmodules({ repoRoot: root })).toEqual([]);
  });
});

describe("live-repo parity", () => {
  test("plugin-sql appears in listPackages with a matching dir", () => {
    const pkg = listPackages({ repoRoot: REPO_ROOT }).find(
      (p) => p.name === "@elizaos/plugin-sql",
    );
    expect(pkg).toBeDefined();
    expect(pkg?.dir).toBe("plugins/plugin-sql");
  });

  test("packages/feed is excluded from listWorkspaceDirs", () => {
    const dirs = listWorkspaceDirs({ repoRoot: REPO_ROOT });
    expect(dirs).not.toContain("packages/feed");
  });

  test("no duplicate package names across the workspace", () => {
    const names = listPackages({ repoRoot: REPO_ROOT })
      .map((p) => p.name)
      .filter((name): name is string => Boolean(name));
    const seen = new Map<string, number>();
    for (const name of names) seen.set(name, (seen.get(name) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
    expect(duplicates).toEqual([]);
  });

  test("listSubmodules entries match .gitmodules declarations", () => {
    const gitmodules = fs.readFileSync(
      path.join(REPO_ROOT, ".gitmodules"),
      "utf8",
    );
    const declaredPaths = [
      ...gitmodules.matchAll(/^\s*path\s*=\s*(.+)$/gm),
    ].map((m) => m[1].trim());
    const libPaths = listSubmodules({ repoRoot: REPO_ROOT }).map((s) => s.path);
    expect(libPaths.sort()).toEqual([...declaredPaths].sort());
  });
});
