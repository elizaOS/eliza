import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function selectLatestIosSimulatorAppProduct(entries) {
  const products = entries
    .map((entry) => ({
      path: typeof entry?.path === "string" ? entry.path.trim() : "",
      mtimeMs: Number(entry?.mtimeMs),
    }))
    .filter(
      (entry) =>
        entry.path.length > 0 &&
        Number.isFinite(entry.mtimeMs) &&
        entry.mtimeMs >= 0,
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));

  return products[0]?.path ?? null;
}

export function findLatestBuiltIosSimulatorApp({
  derivedData = path.join(
    os.homedir(),
    "Library",
    "Developer",
    "Xcode",
    "DerivedData",
  ),
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (!fsImpl.existsSync(derivedData)) return null;

  const output = execFileSyncImpl(
    "find",
    [
      derivedData,
      "-name",
      "App.app",
      "-path",
      "*/Debug-iphonesimulator/*",
      "-type",
      "d",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const entries = String(output)
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({
      path: entry,
      mtimeMs: fsImpl.statSync(entry).mtimeMs,
    }));

  return selectLatestIosSimulatorAppProduct(entries);
}
