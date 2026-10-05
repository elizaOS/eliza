import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { fusedExtraCmakeFlags } from "../build-helpers/omnivoice-merged.ts";
import { resolveElizaWorkspaceRootFromImportMeta } from "../lib/repo-root.ts";
import {
  buildLibllamaForAbi,
  describeAndroidTargetDryRun,
  libllamaCmakeConfigureArgs,
  resetIncompatibleCmakeArchiverCache,
  stageStaticFusedRuntimeBackendLibs,
} from "./compile-libllama.ts";
import {
  resolveAndroidNdkHostDir,
  resolveDefaultAndroidAssetsDir,
  resolveHomebrewFormulaIncludeDirs,
} from "./compile-libllama-paths.ts";
import { ensureZigDrivers } from "./zig-toolchain.ts";

const repoRoot = resolveElizaWorkspaceRootFromImportMeta(import.meta.url);
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.ts",
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

describe("compile-libllama CMake archiver cache", () => {
  test("resets a stale host-archiver build tree", () => {
    const buildDir = makeTmpDir();
    fs.writeFileSync(
      path.join(buildDir, "CMakeCache.txt"),
      "CMAKE_AR:UNINITIALIZED=/tmp/zig-ar\nCMAKE_RANLIB:UNINITIALIZED=/tmp/zig-ranlib\n",
    );
    fs.writeFileSync(path.join(buildDir, "stale-object"), "present");
    const logs = [];

    expect(
      resetIncompatibleCmakeArchiverCache({
        buildDir,
        arPath: "/tmp/zig-ar",
        ranlibPath: "/tmp/zig-ranlib",
        log: (line) => logs.push(line),
      }),
    ).toBe(true);
    expect(fs.existsSync(buildDir)).toBe(false);
    expect(logs.join("\n")).toContain("Reset stale CMake build tree");
  });

  test("preserves a build tree already configured with Zig archivers", () => {
    const buildDir = makeTmpDir();
    fs.writeFileSync(
      path.join(buildDir, "CMakeCache.txt"),
      "CMAKE_AR:FILEPATH=/tmp/zig-ar\nCMAKE_RANLIB:FILEPATH=/tmp/zig-ranlib\n",
    );
    fs.writeFileSync(path.join(buildDir, "compiled-object"), "present");

    expect(
      resetIncompatibleCmakeArchiverCache({
        buildDir,
        arPath: "/tmp/zig-ar",
        ranlibPath: "/tmp/zig-ranlib",
      }),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(buildDir, "compiled-object"), "utf8"),
    ).toBe("present");
  });
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

  test("uses the canonical platforms/android tree when packages/app has no android/", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "packages", "app", "platforms", "android"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, "packages", "app", "package.json"), "{}");

    expect(resolveDefaultAndroidAssetsDir({ root })).toBe(
      path.join(
        root,
        "packages",
        "app",
        "platforms",
        "android",
        "app",
        "src",
        "main",
        "assets",
        "agent",
      ),
    );
  });

  test("defaults to an Android project that exists in this checkout", () => {
    const assetsDir = resolveDefaultAndroidAssetsDir({ root: repoRoot });
    // <android>/app/src/main/assets/agent → <android>
    const androidProject = path.resolve(
      assetsDir,
      "..",
      "..",
      "..",
      "..",
      "..",
    );
    expect(fs.existsSync(androidProject)).toBe(true);
  });

  test("targets a host apps/app shell's own android/ before cap add android, not the nested template", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "apps", "app"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps", "app", "package.json"), "{}");
    fs.mkdirSync(
      path.join(root, "eliza", "packages", "app", "platforms", "android"),
      { recursive: true },
    );

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
    expect(output).toContain("-DLLAMA_OPENSSL=OFF");
    expect(output).toContain("-DKOKORO_ENABLE_ESPEAK=OFF");
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

describe("compile-libllama dry-run CMake plan parity", () => {
  const dryRunCmakeLine = (target, { srcDir, cacheDir, abiAssetDir }) => {
    const logs = [];
    describeAndroidTargetDryRun({
      target,
      srcDir,
      cacheDir,
      abiAssetDir,
      jobs: 2,
      log: (line) => logs.push(line),
    });
    const line = logs.find((entry) => entry.startsWith("  cmake -S "));
    expect(line).toBeDefined();
    return line.slice("  cmake ".length);
  };

  test("prints exactly the configure argv the real x86_64 build passes", () => {
    const srcDir = makeTmpDir();
    const cacheDir = makeTmpDir();
    const abiAssetDir = makeTmpDir();
    const driverDir = path.join(cacheDir, "zig-driver", "x86_64");
    for (const fused of [false, true]) {
      const target = `android-x86_64-cpu${fused ? "-fused" : ""}`;
      const real = libllamaCmakeConfigureArgs({
        srcDir,
        buildDir: path.join(srcDir, "build-x86_64"),
        abi: "x86_64",
        drivers: {
          ccPath: path.join(driverDir, "zig-cc"),
          cxxPath: path.join(driverDir, "zig-cxx"),
          arPath: path.join(driverDir, "zig-ar"),
          ranlibPath: path.join(driverDir, "zig-ranlib"),
        },
        extraCmakeFlags: fused ? fusedExtraCmakeFlags() : [],
      });
      expect(real).toContain("-DGGML_AVX2=ON");
      expect(dryRunCmakeLine(target, { srcDir, cacheDir, abiAssetDir })).toBe(
        real.join(" "),
      );
    }
  });

  test("includes the GGML_VULKAN flag set for Android Vulkan targets", () => {
    const srcDir = makeTmpDir();
    const cacheDir = makeTmpDir();
    const abiAssetDir = makeTmpDir();
    const line = dryRunCmakeLine("android-arm64-vulkan-fused", {
      srcDir,
      cacheDir,
      abiAssetDir,
    });
    expect(line).toContain("-DGGML_VULKAN=ON");
    expect(line).toContain(
      `-DVulkan_INCLUDE_DIR=${path.join(cacheDir, "vulkan-headers")}`,
    );
    expect(line).toContain("-DVulkan_GLSLC_EXECUTABLE=");
    expect(line).toContain("-DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH");
  });
});

describe("compile-libllama llama-server build failure", () => {
  const failingServerSpawn = (_cmd, args) => {
    if (args.includes("llama-server")) {
      throw new Error("cmake --build --target llama-server exited 2");
    }
  };

  test("is fatal for fused targets, which verifyFusedSymbols requires it for", () => {
    const srcDir = makeTmpDir();
    const cacheDir = makeTmpDir();
    const abiAssetDir = makeTmpDir();
    expect(() =>
      buildLibllamaForAbi({
        srcDir,
        cacheDir,
        abi: "x86_64",
        abiAssetDir,
        jobs: 1,
        log: () => {},
        spawn: failingServerSpawn,
        targetName: "android-x86_64-cpu-fused",
        llamaServerRequired: true,
      }),
    ).toThrow(/llama-server failed to build for android-x86_64-cpu-fused/);
  });

  test("warns and continues for non-fused builds", () => {
    const srcDir = makeTmpDir();
    const cacheDir = makeTmpDir();
    const abiAssetDir = makeTmpDir();
    const logs = [];
    // With no real build tree the later libllama staging fails; the point is
    // that the server failure itself did not stop the build.
    expect(() =>
      buildLibllamaForAbi({
        srcDir,
        cacheDir,
        abi: "x86_64",
        abiAssetDir,
        jobs: 1,
        log: (line) => logs.push(line),
        spawn: failingServerSpawn,
      }),
    ).toThrow();
    expect(
      logs.some((line) => line.includes("WARN: llama-server failed to build")),
    ).toBe(true);
  });
});
