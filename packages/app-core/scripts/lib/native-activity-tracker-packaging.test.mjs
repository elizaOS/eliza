/**
 * Deterministic desktop packaging coverage for the generated macOS activity
 * collector: platform/profile gates plus executable and Mach-O architecture
 * validation. Uses synthetic headers only; no Swift toolchain is required.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeActivityTrackerBundleBinary,
  shouldPackageNativeActivityTracker,
  verifyNativeActivityTrackerBinary,
} from "./native-activity-tracker-packaging.mjs";

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
