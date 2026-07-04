/** Exercises compile libllama behavior with deterministic app-core test fixtures. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveElizaWorkspaceRootFromImportMeta } from "../lib/repo-root.mjs";
import {
  resolveAndroidNdkHostDir,
  resolveDefaultAndroidAssetsDir,
  resolveHomebrewFormulaIncludeDirs,
} from "./compile-libllama-paths.mjs";

const repoRoot = resolveElizaWorkspaceRootFromImportMeta(import.meta.url);
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);
const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compile-libllama-test-"));
  tmpDirs.push(dir);
  return dir;
}

function removePathRecursive(targetPath) {
  execFileSync(process.execPath, [cleanupHelperScript, targetPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    removePathRecursive(tmpDirs.pop());
  }
});

describe("compile-libllama Android Vulkan host resolution", () => {
  test("uses the current OS host prebuilt instead of hardcoded linux", () => {
    const prebuiltRoot = makeTmpDir();
    fs.mkdirSync(path.join(prebuiltRoot, "darwin-x86_64"));
    fs.mkdirSync(path.join(prebuiltRoot, "linux-x86_64"));

    expect(
      resolveAndroidNdkHostDir(prebuiltRoot, {
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe("darwin-x86_64");
  });

  test("does not select a prebuilt for the wrong host OS", () => {
    const prebuiltRoot = makeTmpDir();
    fs.mkdirSync(path.join(prebuiltRoot, "linux-x86_64"));

    expect(
      resolveAndroidNdkHostDir(prebuiltRoot, {
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBeNull();
  });

  test("expands Homebrew opt and versioned Cellar include roots", () => {
    const prefix = makeTmpDir();
    fs.mkdirSync(path.join(prefix, "Cellar", "vulkan-headers", "1.3.290"), {
      recursive: true,
    });

    expect(
      resolveHomebrewFormulaIncludeDirs("vulkan-headers", [prefix]),
    ).toEqual([
      path.join(prefix, "opt", "vulkan-headers", "include"),
      path.join(prefix, "Cellar", "vulkan-headers", "1.3.290", "include"),
    ]);
  });
});

describe("compile-libllama Android assets dir resolution", () => {
  test("prefers the flat elizaOS packages/app shell when present", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "packages", "app", "android"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, "apps", "app", "android"), {
      recursive: true,
    });

    expect(resolveDefaultAndroidAssetsDir({ root })).toBe(
      path.join(
        root,
        "packages",
        "app",
        "android",
        "app",
        "src",
        "main",
        "assets",
        "agent",
      ),
    );
  });

  test("uses host apps/app shell when packages/app is absent", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "apps", "app", "android"), {
      recursive: true,
    });

    expect(resolveDefaultAndroidAssetsDir({ root })).toBe(
      path.join(
        root,
        "apps",
        "app",
        "android",
        "app",
        "src",
        "main",
        "assets",
        "agent",
      ),
    );
  });

  test("falls back to nested eliza/packages/app shell", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "eliza", "packages", "app", "android"), {
      recursive: true,
    });

    expect(resolveDefaultAndroidAssetsDir({ root })).toBe(
      path.join(
        root,
        "eliza",
        "packages",
        "app",
        "android",
        "app",
        "src",
        "main",
        "assets",
        "agent",
      ),
    );
  });
});
