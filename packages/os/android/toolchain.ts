import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const JAVA_MAJOR = 21;
const JVM_ROOT = "/usr/lib/jvm";

function firstExisting(paths: readonly (string | undefined)[]): string | null {
  return paths.find((candidate): candidate is string => candidate !== undefined && candidate !== "" && fs.existsSync(candidate)) ?? null;
}

export function resolveAndroidSdkRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  return firstExisting([
    env.ANDROID_SDK_ROOT,
    env.ANDROID_HOME,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
  ]);
}

export function javaMajorVersion(javaHome: string | null | undefined): number | null {
  if (!javaHome || !fs.existsSync(javaHome)) return null;
  const releaseFile = path.join(javaHome, "release");
  const release = fs.existsSync(releaseFile) ? /JAVA_VERSION="?(\d+)/.exec(fs.readFileSync(releaseFile, "utf8")) : null;
  if (release) return Number.parseInt(release[1], 10);
  const javaBin = path.join(javaHome, "bin", "java");
  if (!fs.existsSync(javaBin)) return null;
  const result = spawnSync(javaBin, ["-version"], { encoding: "utf8" });
  const reported = /version "?(\d+)/.exec(`${result.stderr ?? ""}${result.stdout ?? ""}`);
  return reported ? Number.parseInt(reported[1], 10) : null;
}

export function resolveJavaHome(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.JAVA_HOME,
    "/opt/homebrew/opt/openjdk@21",
    "/usr/local/opt/openjdk@21",
    "/usr/lib/jvm/temurin-21-jdk-amd64",
    "/usr/lib/jvm/java-21-openjdk-amd64",
    "/usr/lib/jvm/java-21-openjdk",
    ...(fs.existsSync(JVM_ROOT) ? fs.readdirSync(JVM_ROOT).map((name) => path.join(JVM_ROOT, name)) : []),
  ];
  return candidates.find((candidate) => (javaMajorVersion(candidate) ?? 0) >= JAVA_MAJOR) ?? firstExisting(candidates);
}
