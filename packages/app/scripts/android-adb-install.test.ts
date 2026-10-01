/**
 * Regression tests for the post-install hash verification in
 * android-adb-install. A fake `adb` on PATH plays the device; the APK fixture
 * is a minimal zip carrying the renderer stamp the pre-install guard requires.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ANDROID_APK_RENDERER_MANIFEST_PATH } from "./lib/android-renderer-stamp.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptDir, "android-adb-install.ts");
const appId = readFileSync(
  path.join(scriptDir, "..", "app.config.ts"),
  "utf8",
).match(/appId:\s*["']([^"']+)["']/)?.[1];
const tempDirs: string[] = [];

function u16(value: number) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function writeStoredZip(zipPath: string, entryName: string, content: string) {
  const name = Buffer.from(entryName);
  const data = Buffer.from(content);
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    name,
    data,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    name,
  ]);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  writeFileSync(zipPath, Buffer.concat([local, central, eocd]));
}

interface DeviceBehavior {
  pmPath: string;
  sha256sum: string;
}

function runInstall(device: (localHash: string) => DeviceBehavior) {
  const root = mkdtempSync(path.join(os.tmpdir(), "android-adb-install-"));
  tempDirs.push(root);
  const stamp = JSON.stringify({ buildId: "fixture-build" });
  const rendererDist = path.join(root, "web-dist");
  mkdirSync(rendererDist);
  writeFileSync(path.join(rendererDist, "eliza-renderer-build.json"), stamp);
  const apk = path.join(root, "app-debug.apk");
  writeStoredZip(apk, ANDROID_APK_RENDERER_MANIFEST_PATH, stamp);
  const localHash = createHash("sha256")
    .update(readFileSync(apk))
    .digest("hex");
  const behavior = device(localHash);

  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const adb = path.join(bin, "adb");
  writeFileSync(
    adb,
    `#!/bin/sh
[ "$1" = "-s" ] && shift 2
case "$1" in
  devices) printf 'List of devices attached\\nfixture-serial\\tdevice\\n' ;;
  install) exit 0 ;;
  shell)
    case "$2" in
      pm) ${behavior.pmPath} ;;
      sha256sum) ${behavior.sha256sum} ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(adb, 0o755);

  return spawnSync(
    process.execPath,
    [scriptPath, "--apk", apk, "--no-launch"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
        HOME: root,
        ANDROID_HOME: root,
        ANDROID_SDK_ROOT: root,
        ANDROID_SERIAL: "",
        ELIZA_ANDROID_RENDERER_DIST: rendererDist,
      },
    },
  );
}

const basePath = `echo "package:/data/app/~~x/${appId}-1/base.apk"`;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("android-adb-install hash verification", { timeout: 120_000 }, () => {
  it("fails when the on-device sha256sum command fails", () => {
    const result = runInstall(() => ({
      pmPath: basePath,
      sha256sum: 'echo "sha256sum: not found" >&2; exit 127',
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not hash on-device APK");
    expect(result.stdout).not.toContain("Android install verified");
  });

  it("fails when the device returns no hash", () => {
    const result = runInstall(() => ({
      pmPath: basePath,
      sha256sum: "exit 0",
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("on-device APK sha256 is required");
    expect(result.stdout).not.toContain("Android install verified");
  });

  it("fails when pm path reports no base.apk", () => {
    const result = runInstall(() => ({
      pmPath: `echo "package:/data/app/${appId}-1/split_config.arm64_v8a.apk"`,
      sha256sum: "exit 0",
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no base APK path");
    expect(result.stdout).not.toContain("Android install verified");
  });

  it("fails when the on-device hash differs", () => {
    const result = runInstall(() => ({
      pmPath: basePath,
      sha256sum: `echo "${"0".repeat(64)}  /data/app/base.apk"`,
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("on-device APK does not match");
  });

  it("verifies the install when the on-device hash matches", () => {
    const result = runInstall((localHash) => ({
      pmPath: basePath,
      sha256sum: `echo "${localHash}  /data/app/base.apk"`,
    }));
    expect(result.stderr).not.toContain("android-adb-install:");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Verified on-device APK hash matches");
    expect(result.stdout).toContain(`Android install verified for ${appId}.`);
  });
});
