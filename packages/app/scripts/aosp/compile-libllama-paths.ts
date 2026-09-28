/**
 * Toolchain path helpers for the AOSP/Android libllama cross-compile: zig-style
 * semver comparison and Android NDK prebuilt host-toolchain directory
 * resolution, shared by the llama.cpp build scripts and their tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Compare two semver-ish version strings (zig follows MAJOR.MINOR.PATCH for
 * stable releases; dev builds add `-dev.NNN+sha` which we strip).
 * Returns negative when `a < b`, positive when `a > b`, zero on equal.
 */
export function compareSemver(a, b) {
  const norm = (v) =>
    String(v)
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const aa = norm(a);
  const bb = norm(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export function resolveAndroidNdkHostDir(
  prebuiltRoot,
  { platform = os.platform(), arch = os.arch(), entries } = {},
) {
  const dirs =
    entries ??
    (fs.existsSync(prebuiltRoot) ? fs.readdirSync(prebuiltRoot) : []);
  const hostDirs = dirs
    .filter((d) => /^(linux|darwin|windows)-(x86_64|aarch64|arm64)$/.test(d))
    .sort();
  const hostPrefix =
    platform === "win32"
      ? "windows"
      : platform === "linux" || platform === "darwin"
        ? platform
        : null;
  if (!hostPrefix) return null;

  const preferredArch =
    arch === "x64" ? "x86_64" : arch === "arm64" ? "arm64" : arch;
  const archCandidates =
    preferredArch === "arm64"
      ? ["arm64", "aarch64", "x86_64"]
      : [preferredArch, "x86_64"];
  return (
    archCandidates
      .map((candidate) => `${hostPrefix}-${candidate}`)
      .find((candidate) => hostDirs.includes(candidate)) ??
    hostDirs.find((candidate) => candidate.startsWith(`${hostPrefix}-`)) ??
    null
  );
}

export function resolveHomebrewFormulaIncludeDirs(
  formula,
  prefixes = ["/opt/homebrew", "/usr/local"],
) {
  const includeDirs = [];
  for (const prefix of prefixes) {
    includeDirs.push(path.join(prefix, "opt", formula, "include"));
    const cellar = path.join(prefix, "Cellar", formula);
    if (!fs.existsSync(cellar)) continue;
    for (const version of fs.readdirSync(cellar).sort(compareSemver)) {
      includeDirs.push(path.join(cellar, version, "include"));
    }
  }
  return includeDirs;
}

/**
 * Default `--assets-dir` for the Android agent runtime: `<android>/app/src/main/
 * assets/agent`, where `<android>` is the Android project the mobile build
 * actually uses. A host app's own `android/` dir (whitelabel
 * `ELIZA_ANDROID_USE_APP_DIR=1` builds) wins; otherwise the canonical
 * `platforms/android` tree. Candidates are checked in order across the flat
 * elizaOS layout, a host `apps/app` shell, and a nested `eliza/` checkout.
 */
export function resolveDefaultAndroidAssetsDir({ root = process.cwd() } = {}) {
  const appRelativeCandidates = [
    path.join("packages", "app"),
    path.join("apps", "app"),
    path.join("eliza", "packages", "app"),
  ];
  const assetsAgentDir = (androidDir) =>
    path.join(androidDir, "app", "src", "main", "assets", "agent");
  for (const appRelative of appRelativeCandidates) {
    const appRoot = path.join(root, appRelative);
    for (const androidDir of [
      path.join(appRoot, "android"),
      path.join(appRoot, "platforms", "android"),
    ]) {
      if (fs.existsSync(androidDir)) return assetsAgentDir(androidDir);
    }
  }
  return assetsAgentDir(
    path.join(root, "packages", "app", "platforms", "android"),
  );
}
