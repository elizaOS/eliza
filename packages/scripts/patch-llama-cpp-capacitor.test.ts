/** Exercises the actual dependency installer in temporary Git checkouts, including partial installs and hardlinked package isolation. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const installer = new URL("./patch-llama-cpp-capacitor.ts", import.meta.url);
const patch = `diff --git a/dist/esm/index.js b/dist/esm/index.js
--- a/dist/esm/index.js
+++ b/dist/esm/index.js
@@ -1 +1,2 @@
 export const legacy = 1;
+export const embedding = 2;
diff --git a/types/llama-cpp-capacitor.d.ts b/types/llama-cpp-capacitor.d.ts
--- a/types/llama-cpp-capacitor.d.ts
+++ b/types/llama-cpp-capacitor.d.ts
@@ -1,3 +1,4 @@
 declare module 'llama-cpp-capacitor' {
   export const legacy: number;
+  export const embedding: number;
 }
`;
const initial = {
  "android/src/main/CMakeLists.txt": "project(llama-cpp-capacitor-eliza-mtp)\n",
  "dist/esm/index.js": "export const legacy = 1;\n",
  "types/llama-cpp-capacitor.d.ts":
    "declare module 'llama-cpp-capacitor' {\n  export const legacy: number;\n}\n",
};
const expected = {
  ...initial,
  "dist/esm/index.js":
    "export const legacy = 1;\nexport const embedding = 2;\n",
  "types/llama-cpp-capacitor.d.ts":
    "declare module 'llama-cpp-capacitor' {\n  export const legacy: number;\n  export const embedding: number;\n}\n",
};
const javaPath =
  "android/src/main/java/ai/annadata/plugin/capacitor/LlamaCpp.java";
// Android files as left by the installer when riscv64 was still a target.
const riscv64Android = {
  "android/build.gradle": `ext {
    junitVersion = '4.13.2'
}

def resolveElizaRepoRoot = { ->
    return rootProject.projectDir.toPath().resolve('../../../..').normalize().toFile().absolutePath
}

// unsuffixed names are still honored for backwards compatibility.
// riscv64 has no Vulkan path yet (Wave 2 ships CPU-only), so only the
// \`cpu\` backend is searched on that ABI.
def resolveElizaMtpAndroidLibDir = { String abi ->
    def abiToken = [
        'arm64-v8a': 'android-arm64',
        'x86_64'   : 'android-x86_64',
        'riscv64'  : 'android-riscv64',
    ][abi]
    def backends = abi == 'riscv64' ? ['cpu'] : ['vulkan', 'cpu']
}

def resolveElizaSkipMtpAndroidLib = { ->
    return false
}

buildscript {
}

android {
    defaultConfig {
        ndk {
            abiFilters 'arm64-v8a', 'riscv64'
        }

        externalNativeBuild {
            cmake {
                arguments "-DELIZA_REPO_ROOT=\${resolveElizaRepoRoot()}",
                    "-DELIZA_MTP_ANDROID_LIBDIR_ARM64_V8A=\${resolveElizaMtpAndroidLibDir('arm64-v8a')}",
                    "-DELIZA_MTP_ANDROID_LIBDIR_RISCV64=\${resolveElizaMtpAndroidLibDir('riscv64')}",
                    "-DELIZA_SKIP_MTP_ANDROID_LIB=\${resolveElizaSkipMtpAndroidLib() ? 'ON' : 'OFF'}"
            }
        }
    }
}
`,
  "android/src/main/CMakeLists.txt": `project(llama-cpp-capacitor-eliza-mtp)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
option(ELIZA_SKIP_MTP_ANDROID_LIB "Build a no-op JNI library" OFF)
if(ELIZA_SKIP_MTP_ANDROID_LIB)
    if(ANDROID_ABI STREQUAL "riscv64")
        set(ELIZA_SMOKE_OUTPUT_NAME "llama-cpp-riscv64")
    else()
        set(ELIZA_SMOKE_OUTPUT_NAME "llama-cpp-arm64")
    endif()
    return()
endif()
if(NOT DEFINED ELIZA_REPO_ROOT)
    message(FATAL_ERROR "ELIZA_REPO_ROOT is required for the Eliza MTP Android JNI bridge")
endif()
# Per-ABI MTP lib dirs are passed by android/build.gradle. Only the
# entry for the currently-building ABI is required; the other can be empty.
# riscv64 is CPU-only today (no ggml-vulkan.so produced yet).
if(ANDROID_ABI STREQUAL "arm64-v8a")
    set(ELIZA_MTP_LIBDIR "\${ELIZA_MTP_ANDROID_LIBDIR_ARM64_V8A}")
    set(ELIZA_OUTPUT_NAME "llama-cpp-arm64")
    set(ELIZA_HAS_VULKAN TRUE)
elseif(ANDROID_ABI STREQUAL "riscv64")
    set(ELIZA_MTP_LIBDIR "\${ELIZA_MTP_ANDROID_LIBDIR_RISCV64}")
    set(ELIZA_OUTPUT_NAME "llama-cpp-riscv64")
    set(ELIZA_HAS_VULKAN FALSE)
else()
    message(FATAL_ERROR "Unsupported ANDROID_ABI for Eliza MTP JNI bridge: \${ANDROID_ABI} (expected arm64-v8a or riscv64)")
endif()
set(ELIZA_MTP_JNI_CPP "\${ELIZA_REPO_ROOT}/packages/native/plugins/llama/android/eliza-mtp-jni.cpp")
`,
  [javaPath]: `            switch (abi) {
                case "x86_64":
                    libraryName = "llama-cpp-x86_64";
                    break;
                case "riscv64":
                    libraryName = "llama-cpp-riscv64";
                    break;
                default:
                    libraryName = "llama-cpp-arm64";
                    break;
            }
            // riscv64 currently has no ggml-vulkan.so (Wave 2 CPU-only); the
            // preload is wrapped in try/catch and an absent dependency is
            // logged as a warning rather than failing the load.
            if ("arm64-v8a".equals(abi) || "riscv64".equals(abi)) {
                mtpDependencies.add("ggml-cpu");
                if ("arm64-v8a".equals(abi)) {
                    mtpDependencies.add("ggml-vulkan");
                }
                mtpDependencies.add("ggml");
            }
`,
};
const arm64Android = {
  "android/build.gradle": `ext {
    junitVersion = '4.13.2'
}

def resolveElizaRepoRoot = { ->
    return rootProject.projectDir.toPath().resolve('../../../..').normalize().toFile().absolutePath
}

// unsuffixed names are still honored for backwards compatibility.
def resolveElizaMtpAndroidLibDir = { String abi ->
    def abiToken = [
        'arm64-v8a': 'android-arm64',
        'x86_64'   : 'android-x86_64',
    ][abi]
    def backends = ['vulkan', 'cpu']
}

def resolveElizaSkipMtpAndroidLib = { ->
    return false
}

buildscript {
}

android {
    defaultConfig {
        ndk {
            abiFilters 'arm64-v8a'
        }

        externalNativeBuild {
            cmake {
                arguments "-DELIZA_REPO_ROOT=\${resolveElizaRepoRoot()}",
                    "-DELIZA_MTP_ANDROID_LIBDIR_ARM64_V8A=\${resolveElizaMtpAndroidLibDir('arm64-v8a')}",
                    "-DELIZA_SKIP_MTP_ANDROID_LIB=\${resolveElizaSkipMtpAndroidLib() ? 'ON' : 'OFF'}"
            }
        }
    }
}
`,
  "android/src/main/CMakeLists.txt": `project(llama-cpp-capacitor-eliza-mtp)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
option(ELIZA_SKIP_MTP_ANDROID_LIB "Build a no-op JNI library" OFF)
if(ELIZA_SKIP_MTP_ANDROID_LIB)
    set(ELIZA_SMOKE_OUTPUT_NAME "llama-cpp-arm64")
    return()
endif()
if(NOT DEFINED ELIZA_REPO_ROOT)
    message(FATAL_ERROR "ELIZA_REPO_ROOT is required for the Eliza MTP Android JNI bridge")
endif()
# The arm64-v8a MTP lib dir is passed by android/build.gradle.
if(ANDROID_ABI STREQUAL "arm64-v8a")
    set(ELIZA_MTP_LIBDIR "\${ELIZA_MTP_ANDROID_LIBDIR_ARM64_V8A}")
    set(ELIZA_OUTPUT_NAME "llama-cpp-arm64")
    set(ELIZA_HAS_VULKAN TRUE)
else()
    message(FATAL_ERROR "Unsupported ANDROID_ABI for Eliza MTP JNI bridge: \${ANDROID_ABI} (expected arm64-v8a)")
endif()
set(ELIZA_MTP_JNI_CPP "\${ELIZA_REPO_ROOT}/packages/native/plugins/llama/android/eliza-mtp-jni.cpp")
`,
  [javaPath]: `            switch (abi) {
                case "x86_64":
                    libraryName = "llama-cpp-x86_64";
                    break;
                default:
                    libraryName = "llama-cpp-arm64";
                    break;
            }
            // Each preload is wrapped in try/catch and an absent dependency is
            // logged as a warning rather than failing the load.
            if ("arm64-v8a".equals(abi)) {
                mtpDependencies.add("ggml-cpu");
                mtpDependencies.add("ggml-vulkan");
                mtpDependencies.add("ggml");
            }
`,
};
for (const mode of [
  "existing Android",
  "riscv64 Android",
  "partial bridge",
  "hardlinked",
  "corrupt",
  "previous bridge",
  "current bridge",
  "invalid upgrade",
]) {
  test(`installer admits ${mode} package without silent omissions`, () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-dependency-patch-"),
    );
    try {
      const script = path.join(
        root,
        "packages/scripts/patch-llama-cpp-capacitor.ts",
      );
      const pkg = path.join(root, "node_modules/llama-cpp-capacitor");
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.copyFileSync(installer, script);
      fs.mkdirSync(path.join(root, "patches"));
      fs.writeFileSync(
        path.join(root, "patches/llama-cpp-capacitor@0.1.5.patch"),
        patch,
      );
      assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
      for (const [relative, value] of Object.entries(initial)) {
        const file = path.join(pkg, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value);
      }
      if (mode === "riscv64 Android")
        for (const [relative, value] of Object.entries(riscv64Android)) {
          const file = path.join(pkg, relative);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, value);
        }
      const want =
        mode === "riscv64 Android"
          ? { ...expected, ...arm64Android }
          : expected;
      if (mode === "partial bridge")
        fs.writeFileSync(
          path.join(pkg, "dist/esm/index.js"),
          expected["dist/esm/index.js"],
        );
      if (mode === "corrupt")
        fs.writeFileSync(
          path.join(pkg, "dist/esm/index.js"),
          "incompatible upstream\n",
        );
      if (
        mode === "previous bridge" ||
        mode === "current bridge" ||
        mode === "invalid upgrade"
      ) {
        fs.writeFileSync(
          path.join(pkg, "dist/esm/index.js"),
          `export const legacy = 1;\nexport const embedding = ${mode === "current bridge" ? 0 : 1};\n`,
        );
        fs.writeFileSync(
          path.join(
            root,
            "patches/llama-cpp-capacitor@0.1.5-bge-upgrade.patch",
          ),
          `diff --git a/dist/esm/index.js b/dist/esm/index.js
--- a/dist/esm/index.js
+++ b/dist/esm/index.js
@@ -1,2 +1,2 @@
 export const legacy = 1;
-export const embedding = 1;
+export const embedding = ${mode === "invalid upgrade" ? 3 : 2};
`,
        );
      }
      if (mode === "current bridge") {
        fs.writeFileSync(
          path.join(
            root,
            "patches/llama-cpp-capacitor@0.1.5-bge-cache-upgrade.patch",
          ),
          `diff --git a/dist/esm/index.js b/dist/esm/index.js
--- a/dist/esm/index.js
+++ b/dist/esm/index.js
@@ -1,2 +1,2 @@
 export const legacy = 1;
-export const embedding = 0;
+export const embedding = 2;
`,
        );
      }
      const sibling = path.join(root, "untouched-install");
      if (mode === "hardlinked") {
        for (const relative of Object.keys(initial)) {
          const link = path.join(sibling, relative);
          fs.mkdirSync(path.dirname(link), { recursive: true });
          fs.linkSync(path.join(pkg, relative), link);
          assert.equal(fs.statSync(link).nlink, 2);
        }
      }
      const run = () =>
        spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      const first = run();
      if (mode === "invalid upgrade") {
        assert.equal(first.status, 1);
        assert.match(first.stderr, /Bridge patch verification failed/);
        return;
      }
      if (mode === "corrupt") {
        assert.equal(first.status, 1);
        assert.match(first.stderr, /neither applicable nor verified/);
        return;
      }
      assert.equal(first.status, 0, first.stderr);
      for (const [relative, value] of Object.entries(want))
        assert.equal(fs.readFileSync(path.join(pkg, relative), "utf8"), value);
      const second = run();
      assert.equal(second.status, 0, second.stderr);
      for (const [relative, value] of Object.entries(want))
        assert.equal(fs.readFileSync(path.join(pkg, relative), "utf8"), value);
      if (mode === "hardlinked") {
        for (const [relative, value] of Object.entries(initial))
          assert.equal(
            fs.readFileSync(path.join(sibling, relative), "utf8"),
            value,
          );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
