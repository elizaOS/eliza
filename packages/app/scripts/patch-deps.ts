#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
/**
 * Post-install patches for third-party/runtime packaging issues.
 *
 * First-party @elizaos fixes should land in the @elizaos package source
 * and ship via a release — not be maintained here. Every patch below
 * carries a header stating (a) what's wrong, (b) what version fixes it
 * upstream, (c) when it can be removed.
 *
 * Current responsibilities:
 *   1. Bun/runtime packaging compatibility (broken export maps, stale
 *      cache repairs, nested package skew, platform shims).
 *   2. Dependency compatibility fixes (@noble/*, pty-manager).
 *   3. Startup noise / native loader suppression (bigint-buffer, jsdom).
 *
 * History of retired patches lives in
 * docs/retired-patches.md — do not add new memorial comments in this
 * file.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  patchBrokenElizaCoreRuntimeDists,
  patchCodexFolderApprovalPromptCompat,
  patchExtensionlessJsExports,
  patchGitWorkspaceServiceEsmRequireCompat,
  patchNobleHashesCompat,
  patchPtyManagerCursorPositionCompat,
  patchPtyManagerEsmDirnameCompat,
  patchTsTsxJsGlobs,
  pruneNestedElizaPluginCoreCopies,
  warnStaleBunCache,
} from "./lib/patch-bun-exports.ts";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolveRepoRootFromImportMeta(import.meta.url);
const cleanupHelperScript = resolve(
  root,
  "packages",
  "scripts",
  "rm-path-recursive.ts",
);
function removePathRecursive(targetPath) {
  execFileSync(process.execPath, [cleanupHelperScript, targetPath], {
    cwd: root,
    stdio: "inherit",
  });
}
// ---------------------------------------------------------------------------
// Bust stale Bun cache entries for @elizaos packages.
// See warnStaleBunCache() in lib/patch-bun-exports.ts for details.
// ---------------------------------------------------------------------------
warnStaleBunCache(root);
// ---------------------------------------------------------------------------
// Bun auto-installs @types/* packages into node_modules/.bun/ and can resolve
// them at runtime instead of the real packages. The .d.ts files use
// TypeScript-only syntax like `export as namespace X;` which causes
// "Unexpected as" parse errors in Bun. Remove @types entries from the virtual
// store cache, but keep node_modules/@types intact because TypeScript builds
// need those packages.
// ---------------------------------------------------------------------------
{
  let removedCount = 0;
  for (const nmDir of [
    resolve(root, "node_modules/.bun"),
    resolve(root, "eliza/node_modules/.bun"),
  ]) {
    if (existsSync(nmDir)) {
      try {
        for (const entry of readdirSync(nmDir)) {
          if (entry.startsWith("@types+")) {
            removePathRecursive(resolve(nmDir, entry));
            removedCount++;
          }
        }
      } catch {}
    }
  }
  if (removedCount > 0) {
    console.log(
      `[patch-deps] Removed ${removedCount} @types entries from Bun virtual store cache (prevents runtime .d.ts parse errors)`,
    );
  }
}
// @noble/hashes only exports subpaths with explicit ".js" suffixes (for
// example "./sha3.js"), but ethers imports "@noble/hashes/sha3". Add
// extensionless aliases so Bun resolves the published package at runtime.
patchExtensionlessJsExports(root, "@noble/hashes");
patchNobleHashesCompat(root);
patchCodexFolderApprovalPromptCompat(root);
patchBrokenElizaCoreRuntimeDists(root);
patchPtyManagerEsmDirnameCompat(root);
patchPtyManagerCursorPositionCompat(root);
patchGitWorkspaceServiceEsmRequireCompat(root);
// @elizaos/agent and @elizaos/ui ship exports maps where glob targets still
// carry the source extension (e.g. "./packages/agent/src/runtime/*.ts.js").
// Bun fails to resolve those because the actual emitted dist files are *.js.
// Rewrite the broken globs until eliza/packages/scripts/prepare-package-dist.ts is fixed
// upstream and we bump the @elizaos/agent and @elizaos/ui tarballs.
patchTsTsxJsGlobs(root, "@elizaos/agent");
patchTsTsxJsGlobs(root, "@elizaos/ui");
pruneNestedElizaPluginCoreCopies(root);
function uniqueResolvedPaths(paths) {
  return [...new Set(paths.map((candidate) => resolve(candidate)))];
}
function collectInstalledPackageDirs(
  packageName,
  { includeGlobalBunCache = false } = {},
) {
  const searchDirs = [resolve(root, `node_modules/${packageName}`)];
  const bunCacheDir = resolve(root, "node_modules/.bun");
  if (existsSync(bunCacheDir)) {
    const bunEntryPrefix = `${packageName.replace("/", "+")}@`;
    try {
      for (const entry of readdirSync(bunCacheDir)) {
        if (entry.startsWith(bunEntryPrefix)) {
          searchDirs.push(
            resolve(bunCacheDir, entry, "node_modules", packageName),
          );
        }
      }
    } catch {}
  }
  if (includeGlobalBunCache && process.env.HOME) {
    const globalBunCacheDir = resolve(
      process.env.HOME,
      ".bun",
      "install",
      "cache",
    );
    if (existsSync(globalBunCacheDir)) {
      const [scope, unscopedName] = packageName.split("/");
      if (packageName.startsWith("@") && unscopedName) {
        const scopedCacheDir = resolve(globalBunCacheDir, scope);
        if (existsSync(scopedCacheDir)) {
          const globalEntryPrefix = `${unscopedName}@`;
          try {
            for (const entry of readdirSync(scopedCacheDir)) {
              if (entry.startsWith(globalEntryPrefix)) {
                searchDirs.push(resolve(scopedCacheDir, entry));
              }
            }
          } catch {}
        }
      } else {
        const globalEntryPrefix = `${packageName}@`;
        try {
          for (const entry of readdirSync(globalBunCacheDir)) {
            if (entry.startsWith(globalEntryPrefix)) {
              searchDirs.push(resolve(globalBunCacheDir, entry));
            }
          }
        } catch {}
      }
    }
  }
  return uniqueResolvedPaths(searchDirs);
}
// ---------------------------------------------------------------------------
// @elizaos/plugin-openrouter — this repo uses workspace:* during local
// development, but the last known-good published tarball remains 2.0.0-alpha.10.
//
// WHY: npm @elizaos/plugin-openrouter@2.0.0-alpha.12 shipped truncated
// dist/node/index.node.js and dist/browser/index.browser.js: only the config
// helper chunk is present, but the module still exports openrouterPlugin /
// default aliases for symbols that are never defined. Bun then fails loading
// the plugin ("not declared in this file"). alpha.10 publishes a full bundle.
// We do not patch the broken tarball here because the implementation chunk is
// missing entirely (unlike plugin-pdf's wrong export identifier).
//
// Before bumping: verify the new tarball's dist entry defines the plugin, or
// run: bun build node_modules/@elizaos/plugin-openrouter/dist/node/index.node.js --target=bun
// Docs: docs/plugin-resolution-and-node-path.md (Pinned: @elizaos/plugin-openrouter)
// ---------------------------------------------------------------------------
/**
 * Patch bigint-buffer optional native binding warning noise.
 *
 * Workspace override plugins can resolve transitive packages directly from the
 * user's Bun install cache instead of the repo's node_modules tree. When
 * bigint-buffer cannot build its optional native addon, it logs a warning even
 * though the pure JS fallback is fully functional. Keep the fallback and hide
 * the warning unless explicitly debugging native bindings.
 */
function patchBigintBufferNativeFallbackNoise() {
  const relPaths = ["dist/node.js"];
  const searchDirs = [resolve(root, "node_modules/bigint-buffer")];
  const bunCacheDir = resolve(root, "node_modules/.bun");
  if (existsSync(bunCacheDir)) {
    try {
      for (const entry of readdirSync(bunCacheDir)) {
        if (entry.startsWith("bigint-buffer@")) {
          searchDirs.push(
            resolve(bunCacheDir, entry, "node_modules/bigint-buffer"),
          );
        }
      }
    } catch {}
  }
  const globalBunCacheDir =
    process.env.HOME &&
    existsSync(resolve(process.env.HOME, ".bun", "install", "cache"))
      ? resolve(process.env.HOME, ".bun", "install", "cache")
      : null;
  if (globalBunCacheDir) {
    try {
      for (const entry of readdirSync(globalBunCacheDir)) {
        if (entry.startsWith("bigint-buffer@")) {
          searchDirs.push(resolve(globalBunCacheDir, entry));
        }
      }
    } catch {}
  }
  const oldSnippet =
    "console.warn('bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)');";
  const newSnippet =
    "if (process.env.ELIZA_DEBUG_BIGINT_BINDINGS === \"1\") {\n        console.warn('bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)');\n    }";
  let patched = 0;
  for (const dir of uniqueResolvedPaths(searchDirs)) {
    for (const relPath of relPaths) {
      const target = resolve(dir, relPath);
      if (!existsSync(target)) continue;
      let src = readFileSync(target, "utf8");
      if (!src.includes(oldSnippet)) continue;
      src = src.replace(oldSnippet, newSnippet);
      writeFileSync(target, src, "utf8");
      patched++;
      console.log(
        `[patch-deps] Applied bigint-buffer native fallback log patch: ${target}`,
      );
    }
  }
  if (patched > 0) {
    console.log(
      `[patch-deps] bigint-buffer: patched ${patched} native fallback warning path(s).`,
    );
  }
}
patchBigintBufferNativeFallbackNoise();
/**
 * Keep jsdom from eagerly requiring node-canvas on startup.
 *
 * Browser-workspace code uses jsdom for DOM parsing, but Eliza does not need
 * canvas-backed rendering in normal runtime boot. jsdom's eager `require("canvas")`
 * pulls in a second libvips/gio stack on macOS, which collides with sharp.
 * Make canvas opt-in for the rare cases that genuinely need it.
 */
function patchJsdomCanvasAutoload() {
  const relPaths = ["lib/jsdom/utils.js"];
  const searchDirs = collectInstalledPackageDirs("jsdom", {
    includeGlobalBunCache: true,
  });
  const oldSnippet = `try {
  exports.Canvas = require("canvas");
} catch {
  exports.Canvas = null;
}`;
  const newSnippet = `if (process.env.ELIZA_ENABLE_JSDOM_CANVAS === "1") {
  try {
    exports.Canvas = require("canvas");
  } catch {
    exports.Canvas = null;
  }
} else {
  exports.Canvas = null;
}`;
  let patched = 0;
  for (const dir of searchDirs) {
    for (const relPath of relPaths) {
      const target = resolve(dir, relPath);
      if (!existsSync(target)) continue;
      const src = readFileSync(target, "utf8");
      if (!src.includes(oldSnippet)) continue;
      writeFileSync(target, src.replace(oldSnippet, newSnippet), "utf8");
      patched++;
      console.log(
        `[patch-deps] Disabled eager jsdom canvas autoload: ${target}`,
      );
    }
  }
  if (patched > 0) {
    console.log(
      `[patch-deps] jsdom: patched ${patched} eager canvas autoload path(s).`,
    );
  }
}
patchJsdomCanvasAutoload();
/**
 * Vite caches prebundled dependencies under node_modules/.vite. When patch-deps
 * rewrites installed @elizaos packages, that cache can keep serving the old
 * upstream app bundle until it is cleared or Vite is forced to rebuild.
 * Always drop the optimize cache here so the frontend picks up patched deps.
 */
for (const viteCacheDir of [
  resolve(root, "node_modules", ".vite"),
  resolve(root, "packages/app", "node_modules", ".vite"),
  resolve(root, "apps/app", "node_modules", ".vite"),
]) {
  if (!existsSync(viteCacheDir)) continue;
  removePathRecursive(viteCacheDir);
  console.log(`[patch-deps] Cleared Vite optimize cache: ${viteCacheDir}`);
}
/**
 * Patch llama-cpp-capacitor Gradle syntax for Gradle 9 / AGP 9 compatibility.
 *
 * The published 0.1.5 package still uses Groovy's deprecated space-assignment
 * form (`namespace "..."`, `abortOnError false`, etc.). Newer Gradle keeps
 * warning about it and Bun's patchfile parser is stricter than git's, so we
 * normalize the installed package directly after install.
 */
function patchLlamaCppCapacitorGradle() {
  const relPath = "android/build.gradle";
  const replacements = [
    [
      'namespace "ai.annadata.plugin.capacitor"',
      'namespace = "ai.annadata.plugin.capacitor"',
    ],
    ['version "3.22.1"', 'version = "3.22.1"'],
    ['ndkVersion "29.0.13113456"', 'ndkVersion = "29.0.13113456"'],
    ["abortOnError false", "abortOnError = false"],
    [
      "getDefaultProguardFile('proguard-android.txt')",
      "getDefaultProguardFile('proguard-android-optimize.txt')",
    ],
  ];
  const searchDirs = collectInstalledPackageDirs("llama-cpp-capacitor", {
    includeGlobalBunCache: true,
  });
  let patched = 0;
  for (const dir of searchDirs) {
    const target = resolve(dir, relPath);
    if (!existsSync(target)) continue;
    let src = readFileSync(target, "utf8");
    let changed = false;
    for (const [before, after] of replacements) {
      if (!src.includes(before)) continue;
      src = src.replaceAll(before, after);
      changed = true;
    }
    if (!changed) continue;
    writeFileSync(target, src, "utf8");
    patched++;
    console.log(
      `[patch-deps] Applied llama-cpp-capacitor Gradle compatibility patch: ${target}`,
    );
  }
  if (patched > 0) {
    console.log(
      `[patch-deps] llama-cpp-capacitor: patched ${patched} Gradle file(s).`,
    );
  }
}
patchLlamaCppCapacitorGradle();
/**
 * Patch llama-cpp-capacitor's Android embedding JNI for Capacitor 8.
 *
 * The published 0.1.5 Android JNI asks JSObject for getDouble(String), but
 * Capacitor 8 exposes that helper on PluginCall, not JSObject. GetMethodID
 * leaves a pending NoSuchMethodError, then the next JNI lookup aborts the app.
 * Use JSONObject's inherited optDouble(String, double) instead.
 */
function patchLlamaCppCapacitorAndroidEmbeddingParams() {
  const relPath = "android/src/main/jni.cpp";
  const oldSnippet = `                // Try to get embd_normalize
                jmethodID getDoubleMethod = env->GetMethodID(jsObjectClass, "getDouble", "(Ljava/lang/String;)Ljava/lang/Double;");
                if (getDoubleMethod != nullptr && !env->ExceptionCheck()) {
                    jstring normalizeKey = jni_utils::string_to_jstring(env, "embd_normalize");
                    jobject normalizeObj = env->CallObjectMethod(params, getDoubleMethod, normalizeKey);
                    if (normalizeObj != nullptr && !env->ExceptionCheck()) {
                        embd_normalize = env->CallDoubleMethod(normalizeObj,
                            env->GetMethodID(env->FindClass("java/lang/Double"), "doubleValue", "()D"));
                        env->DeleteLocalRef(normalizeObj);
                    }
                    env->DeleteLocalRef(normalizeKey);
                    if (env->ExceptionCheck()) {
                        env->ExceptionClear();
                    }
                }`;
  const newSnippet = `                // Capacitor 8 JSObject extends JSONObject and does not expose
                // getDouble(String); use JSONObject's inherited optDouble
                // signature so a missing helper cannot leave a pending JNI
                // exception and abort the app after embedding completes.
                jmethodID optDoubleMethod = env->GetMethodID(jsObjectClass, "optDouble", "(Ljava/lang/String;D)D");
                if (env->ExceptionCheck()) {
                    env->ExceptionClear();
                    optDoubleMethod = nullptr;
                }
                if (optDoubleMethod != nullptr) {
                    jstring normalizeKey = jni_utils::string_to_jstring(env, "embd_normalize");
                    embd_normalize = env->CallDoubleMethod(params, optDoubleMethod, normalizeKey, embd_normalize);
                    env->DeleteLocalRef(normalizeKey);
                    if (env->ExceptionCheck()) {
                        env->ExceptionClear();
                        embd_normalize = 1.0;
                    }
                }`;
  const searchDirs = collectInstalledPackageDirs("llama-cpp-capacitor", {
    includeGlobalBunCache: true,
  });
  let patched = 0;
  for (const dir of searchDirs) {
    const target = resolve(dir, relPath);
    if (!existsSync(target)) continue;
    let src = readFileSync(target, "utf8");
    if (!src.includes(oldSnippet)) continue;
    src = src.replace(oldSnippet, newSnippet);
    writeFileSync(target, src, "utf8");
    patched++;
    console.log(
      `[patch-deps] Applied llama-cpp-capacitor Android embedding JNI patch: ${target}`,
    );
  }
  if (patched > 0) {
    console.log(
      `[patch-deps] llama-cpp-capacitor: patched ${patched} Android embedding JNI path(s).`,
    );
  }
}
patchLlamaCppCapacitorAndroidEmbeddingParams();
