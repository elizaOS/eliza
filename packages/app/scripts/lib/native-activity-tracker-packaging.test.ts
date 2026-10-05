/**
 * Covers the native activity helper's package gate with synthetic Mach-O
 * headers, including platform selection, executable mode, architecture, and
 * the final bundle path. No Swift toolchain is used by this test.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeActivityTrackerBundleBinary,
  shouldPackageNativeActivityTracker,
  verifyBundledNativeActivityTracker,
  verifyNativeActivityTrackerBinary,
} from "./native-activity-tracker-packaging.ts";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeMachO(cpuType, mode = 0o755) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-activity-test-"));
  tempDirs.push(dir);
  const binary = path.join(dir, "activity-collector");
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpuType, 4);
  fs.writeFileSync(binary, header, { mode });
  return binary;
}

describe("native activity tracker desktop packaging", () => {
  it("includes only non-cloud direct/full Darwin desktop builds", () => {
    expect(
      shouldPackageNativeActivityTracker({
        platform: "darwin",
        buildVariant: "direct",
        buildProfile: "full",
        cloudOnly: false,
      }),
    ).toBe(true);
    for (const override of [
      { platform: "linux" },
      { platform: "win32" },
      { buildVariant: "store" },
      { buildProfile: "no-streaming" },
      { cloudOnly: true },
    ]) {
      expect(
        shouldPackageNativeActivityTracker({
          platform: "darwin",
          buildVariant: "direct",
          buildProfile: "full",
          cloudOnly: false,
          ...override,
        }),
      ).toBe(false);
    }
  });

  it("accepts an executable Mach-O matching the target architecture", () => {
    const binary = writeMachO(0x0100000c);
    expect(
      verifyNativeActivityTrackerBinary(binary, {
        arch: "arm64",
        label: "fixture",
      }),
    ).toMatchObject({ arch: "arm64", mode: 0o755, size: 32 });
  });

  it.each([
    ["missing", () => path.join(os.tmpdir(), "does-not-exist")],
    ["not executable", () => writeMachO(0x0100000c, 0o644)],
    ["wrong architecture", () => writeMachO(0x01000007)],
    [
      "not Mach-O",
      () => {
        const binary = writeMachO(0x0100000c);
        fs.writeFileSync(binary, Buffer.from("not-macho"), { mode: 0o755 });
        return binary;
      },
    ],
  ])("rejects a %s helper", (_label, createBinary) => {
    expect(() =>
      verifyNativeActivityTrackerBinary(createBinary(), {
        arch: "arm64",
        label: "fixture",
      }),
    ).toThrow();
  });

  it("binds verification to the packaged eliza-dist dependency path", () => {
    expect(nativeActivityTrackerBundleBinary("/tmp/Eliza.app")).toBe(
      "/tmp/Eliza.app/Contents/Resources/app/eliza-dist/node_modules/@elizaos/native-activity-tracker/native/macos/activity-collector",
    );
  });
});

function createBundle({
  cpuType = 0x0100000c,
  mode = 0o755,
  archived = true,
  missing = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-activity-bundle-"));
  tempDirs.push(root);
  const bundle = path.join(root, "Eliza canary.app");
  const binary = nativeActivityTrackerBundleBinary(bundle);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  if (!missing) {
    fs.copyFileSync(writeMachO(cpuType, mode), binary);
    fs.chmodSync(binary, mode);
  }
  if (archived) {
    const archive = path.join(root, "runtime.tar.zst");
    execFileSync("tar", [
      "--zstd",
      "-cf",
      archive,
      "-C",
      root,
      path.basename(bundle),
    ]);
    const resources = path.join(bundle, "Contents", "Resources");
    fs.rmSync(path.join(resources, "app"), { recursive: true });
    fs.renameSync(archive, path.join(resources, "runtime.tar.zst"));
  }
  return bundle;
}

describe("final native activity helper payload", () => {
  it.each([false, true])(
    "validates the actual executable in archived=%s layout",
    (archived) => {
      expect(
        verifyBundledNativeActivityTracker(createBundle({ archived }), {
          arch: "arm64",
        }),
      ).toMatchObject({ arch: "arm64", mode: 0o755, size: 32 });
    },
  );
  it.each([
    ["wrong architecture", { cpuType: 0x01000007 }, /architecture mismatch/],
    ["non-executable", { mode: 0o644 }, /not executable/],
    ["missing", { missing: true }, /tar/],
  ])("rejects an archived %s helper", (_name, options, message) => {
    expect(() =>
      verifyBundledNativeActivityTracker(createBundle(options), {
        arch: "arm64",
      }),
    ).toThrow(message);
  });
  it("rejects ambiguous release payloads instead of selecting an arbitrary archive", () => {
    const bundle = createBundle();
    const resources = path.join(bundle, "Contents", "Resources");
    fs.copyFileSync(
      path.join(resources, "runtime.tar.zst"),
      path.join(resources, "other.tar.zst"),
    );
    expect(() =>
      verifyBundledNativeActivityTracker(bundle, { arch: "arm64" }),
    ).toThrow(/found 2/);
  });
});
