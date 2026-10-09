/** Resolves host tools and subprocess environments for Android and iOS builds. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export function resolveNodeExecutable() {
  if (!process.versions?.bun) return process.execPath;
  return process.env.NODE?.trim() || "node";
}

export function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

export function resolveExecutable(name) {
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

export function resolveBunExecutable() {
  if (process.versions.bun) return process.execPath;
  return resolveExecutable("bun");
}

export function resolveAndroidSdkRoot(env = process.env) {
  return firstExisting([
    env.ANDROID_SDK_ROOT,
    env.ANDROID_HOME,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
    path.join(
      env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Android",
      "Sdk",
    ),
  ]);
}

export function javaMajorVersion(javaHome) {
  if (!javaHome || !fs.existsSync(javaHome)) return null;
  // `release` is the cheapest, most reliable source (no JVM spawn).
  const releaseFile = path.join(javaHome, "release");
  if (fs.existsSync(releaseFile)) {
    const m = fs
      .readFileSync(releaseFile, "utf8")
      .match(/JAVA_VERSION="?(\d+)/);
    if (m) return Number.parseInt(m[1], 10);
  }
  const javaBin = path.join(
    javaHome,
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
  if (fs.existsSync(javaBin)) {
    const r = spawnSync(javaBin, ["-version"], { encoding: "utf8" });
    const m = `${r.stderr ?? ""}${r.stdout ?? ""}`.match(/version "?(\d+)/);
    if (m) return Number.parseInt(m[1], 10);
  }
  return null;
}

// Auto-select a JDK >= 21 so a plain `build:android` "just works" with no
// JAVA_HOME juggling. JAVA_HOME is honored ONLY when it actually is >= 21;
// otherwise we fall through to the well-known JDK 21 install paths and finally
// scan /usr/lib/jvm. (AGP 9 + the Android toolchain require 21.)
export function resolveJavaHome(env = process.env) {
  const candidates = [
    env.JAVA_HOME,
    "/opt/homebrew/opt/openjdk@21",
    "/usr/local/opt/openjdk@21",
    "/usr/lib/jvm/temurin-21-jdk-amd64",
    "/usr/lib/jvm/java-21-openjdk-amd64",
    "/usr/lib/jvm/java-21-openjdk",
  ];
  for (const candidate of candidates) {
    if (candidate && (javaMajorVersion(candidate) ?? 0) >= 21) return candidate;
  }
  const jvmRoot = "/usr/lib/jvm";
  if (fs.existsSync(jvmRoot)) {
    for (const name of fs.readdirSync(jvmRoot)) {
      const full = path.join(jvmRoot, name);
      if ((javaMajorVersion(full) ?? 0) >= 21) return full;
    }
  }
  if (process.platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    for (const vendor of ["Eclipse Adoptium", "Microsoft", "Java", "Zulu"]) {
      const vendorRoot = path.join(programFiles, vendor);
      if (!fs.existsSync(vendorRoot)) continue;
      for (const name of fs.readdirSync(vendorRoot)) {
        const full = path.join(vendorRoot, name);
        if ((javaMajorVersion(full) ?? 0) >= 21) return full;
      }
    }
  }
  // Nothing >= 21 found — return the first path that exists so the caller's
  // "JDK 21 not found" error fires with a concrete (if wrong-version) hint.
  return firstExisting(candidates);
}

export function resolveRubyUserGemBin() {
  const result = spawnSync("ruby", ["-rrubygems", "-e", "print Gem.user_dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const dir = result.stdout?.trim();
  if (!dir) return null;
  return path.join(dir, "bin");
}

export function withCocoaPodsEnv(baseEnv = process.env) {
  const pathEntries = [
    resolveRubyUserGemBin(),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter((entry) => entry && fs.existsSync(entry));
  const existingPath = baseEnv.PATH ?? process.env.PATH ?? "";
  const rubyOpt = baseEnv.RUBYOPT ?? process.env.RUBYOPT ?? "";
  return {
    ...baseEnv,
    PATH:
      pathEntries.length > 0
        ? `${pathEntries.join(path.delimiter)}${path.delimiter}${existingPath}`
        : existingPath,
    RUBYOPT: rubyOpt.includes("-rlogger")
      ? rubyOpt
      : ["-rlogger", rubyOpt].filter(Boolean).join(" "),
  };
}
