/** Exercises real CMake and NDK compilation across a warm toolchain switch; requires two installed NDK versions. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  androidCmakeBuildDirectory,
  assertAndroidCmakeCompilers,
} from "./android-cmake-cache.mjs";

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const ndkRoot = sdk && path.join(sdk, "ndk");
const versions =
  ndkRoot && existsSync(ndkRoot)
    ? readdirSync(ndkRoot)
        .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];

test("a warm NDK switch is rejected and isolated caches compile with their selected toolchain", {
  skip:
    versions.length < 2
      ? "Two real Android NDK installations are required for compiler-switch proof"
      : false,
  timeout: 120_000,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "android-cmake-cache-"));
  const older = path.join(ndkRoot, versions.at(-2));
  const newer = path.join(ndkRoot, versions.at(-1));
  writeFileSync(
    path.join(root, "CMakeLists.txt"),
    "cmake_minimum_required(VERSION 3.22)\nproject(ndk_cache_probe C CXX)\nadd_library(probe SHARED probe.cpp)\n",
  );
  writeFileSync(
    path.join(root, "probe.cpp"),
    'extern "C" int eliza_ndk_probe() { return __ANDROID_API__; }\n',
  );
  const configure = (directory, ndk) =>
    execFileSync(
      "cmake",
      [
        "-S",
        root,
        "-B",
        directory,
        "-G",
        "Ninja",
        `-DCMAKE_TOOLCHAIN_FILE=${path.join(ndk, "build/cmake/android.toolchain.cmake")}`,
        "-DANDROID_ABI=arm64-v8a",
        "-DANDROID_PLATFORM=android-23",
      ],
      { stdio: "pipe" },
    );
  try {
    const warm = path.join(root, "legacy-cache");
    configure(warm, newer);
    configure(warm, older);
    assert.throws(
      () => assertAndroidCmakeCompilers({ buildDir: warm, ndk: older }),
      /does not belong to selected NDK/,
    );
    for (const ndk of [newer, older]) {
      const buildDir = androidCmakeBuildDirectory({
        cacheRoot: root,
        ndk,
        abi: "arm64-v8a",
        platform: "android-23",
        variant: "cpu",
      });
      configure(buildDir, ndk);
      const compilers = assertAndroidCmakeCompilers({ buildDir, ndk });
      execFileSync(
        "cmake",
        ["--build", buildDir, "--target", "probe", "-j", "1"],
        { stdio: "pipe" },
      );
      const tools = path.dirname(compilers.CXX);
      const readelf = path.join(
        tools,
        process.platform === "win32" ? "llvm-readelf.exe" : "llvm-readelf",
      );
      const artifact = path.join(buildDir, "libprobe.so");
      const header = execFileSync(readelf, ["-h", artifact], {
        encoding: "utf8",
      });
      assert.match(header, /Machine:\s+AArch64/);
      assert.ok(compilers.CXX.startsWith(`${realpathSync(ndk)}${path.sep}`));
      assert.doesNotThrow(() => assertAndroidCmakeCompilers({ buildDir, ndk }));
      assert.throws(
        () =>
          assertAndroidCmakeCompilers({
            buildDir,
            ndk: ndk === newer ? older : newer,
          }),
        /does not belong to selected NDK/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
