/** Exercises compile libllama behavior with deterministic app-core test fixtures. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveElizaWorkspaceRootFromImportMeta } from "../lib/repo-root.mjs";
import {
  describeAndroidTargetDryRun,
  ensureZigDrivers,
  stageStaticFusedRuntimeBackendLibs,
} from "./compile-libllama.mjs";
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
      target: "android-arm64-vulkan-fused",
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
    expect(output).toContain("ggml-vulkan");
    expect(output).toContain("static marker in libelizainference.so");
  });
});

describe("compile-libllama static-fused runtime backend staging", () => {
  test("copies libggml-vulkan beside libelizainference for Android Vulkan fused builds", () => {
    const buildDir = makeTmpDir();
    const abiAssetDir = makeTmpDir();
    const nestedBackendDir = path.join(buildDir, "ggml", "src");
    fs.mkdirSync(nestedBackendDir, { recursive: true });
    fs.writeFileSync(
      path.join(nestedBackendDir, "libggml-vulkan.so"),
      "vulkan-backend",
    );
    const logs = [];

    const staged = stageStaticFusedRuntimeBackendLibs({
      buildDir,
      abiAssetDir,
      target: "android-arm64-vulkan-fused",
      log: (line) => logs.push(line),
    });

    expect(staged).toEqual([path.join(abiAssetDir, "libggml-vulkan.so")]);
    expect(fs.readFileSync(staged[0], "utf8")).toBe("vulkan-backend");
    expect(logs.join("\n")).toContain("Copied libggml-vulkan.so");
  });

  test("accepts static-linked Vulkan evidence when no separate backend is emitted", () => {
    const buildDir = makeTmpDir();
    const abiAssetDir = makeTmpDir();
    const fusedLibPath = path.join(abiAssetDir, "libelizainference.so");
    fs.writeFileSync(fusedLibPath, "GGML_VK_FA_ALLOW_SUBGROUPS");
    const logs = [];

    const staged = stageStaticFusedRuntimeBackendLibs({
      buildDir,
      abiAssetDir,
      target: "android-arm64-vulkan-fused",
      fusedLibPath,
      log: (line) => logs.push(line),
    });

    expect(staged).toEqual([]);
    expect(logs.join("\n")).toContain("statically inside libelizainference.so");
  });

  test("does not stage a Vulkan backend for CPU fused builds", () => {
    const staged = stageStaticFusedRuntimeBackendLibs({
      buildDir: makeTmpDir(),
      abiAssetDir: makeTmpDir(),
      target: "android-x86_64-cpu-fused",
    });

    expect(staged).toEqual([]);
  });

  test("fails closed when a Vulkan fused build has no backend evidence", () => {
    expect(() =>
      stageStaticFusedRuntimeBackendLibs({
        buildDir: makeTmpDir(),
        abiAssetDir: makeTmpDir(),
        target: "android-arm64-vulkan-fused",
        fusedLibPath: null,
      }),
    ).toThrow(/libggml-vulkan\.so/);
  });
});
