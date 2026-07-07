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
import {
  describeAndroidTargetDryRun,
  ensureZigDrivers,
} from "./compile-libllama.mjs";

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

describe("compile-libllama Zig driver generation", () => {
  test("routes CMake archiving through zig ar and zig ranlib", () => {
    const cacheDir = makeTmpDir();
    const zigBin = path.join(cacheDir, "zig with spaces");

    const { ccPath, cxxPath, arPath, ranlibPath } = ensureZigDrivers({
      cacheDir,
      abi: "arm64-v8a",
      zigBin,
    });

    expect(path.basename(ccPath)).toBe("zig-cc");
    expect(path.basename(cxxPath)).toBe("zig-cxx");
    expect(path.basename(arPath)).toBe("zig-ar");
    expect(path.basename(ranlibPath)).toBe("zig-ranlib");

    for (const driverPath of [ccPath, cxxPath, arPath, ranlibPath]) {
      expect(fs.statSync(driverPath).mode & 0o111).not.toBe(0);
    }

    const arBody = fs.readFileSync(arPath, "utf8");
    const ranlibBody = fs.readFileSync(ranlibPath, "utf8");
    expect(arBody).toContain(`exec "${zigBin}" ar "$@"`);
    expect(ranlibBody).toContain(`exec "${zigBin}" ranlib "$@"`);
    expect(arBody).not.toContain("--target=");
    expect(ranlibBody).not.toContain("--target=");
  });

  test("surfaces zig ar and ranlib paths in the Android dry-run CMake plan", () => {
    const srcDir = makeTmpDir();
    const cacheDir = makeTmpDir();
    const abiAssetDir = makeTmpDir();
    const logs = [];

    describeAndroidTargetDryRun({
      target: "android-arm64-vulkan",
      srcDir,
      cacheDir,
      abiAssetDir,
      jobs: 2,
      log: (line) => logs.push(line),
    });

    const output = logs.join("\n");
    const driverDir = path.join(cacheDir, "zig-driver", "arm64-v8a");
    expect(output).toContain(`-DCMAKE_AR=${path.join(driverDir, "zig-ar")}`);
    expect(output).toContain(
      `-DCMAKE_RANLIB=${path.join(driverDir, "zig-ranlib")}`,
    );
  });
});
