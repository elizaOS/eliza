import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeComputerUseBundleBinary,
  shouldPackageNativeComputerUse,
  verifyNativeComputerUseBinary,
} from "./native-computeruse-packaging.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeMachO(cpuType, mode = 0o755) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-computeruse-test-"));
  tempDirs.push(dir);
  const binary = path.join(dir, "accessibility-control");
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpuType, 4);
  fs.writeFileSync(binary, header, { mode });
  return binary;
}

describe("native Computer Use desktop packaging", () => {
  it("includes only non-cloud direct/full Darwin desktop builds", () => {
    expect(
      shouldPackageNativeComputerUse({
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
        shouldPackageNativeComputerUse({
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
      verifyNativeComputerUseBinary(binary, {
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
      verifyNativeComputerUseBinary(createBinary(), {
        arch: "arm64",
        label: "fixture",
      }),
    ).toThrow();
  });

  it("binds verification to the packaged plugin dependency path", () => {
    expect(nativeComputerUseBundleBinary("/tmp/Eliza.app")).toBe(
      "/tmp/Eliza.app/Contents/Resources/app/eliza-dist/node_modules/@elizaos/plugin-computeruse/native/macos/accessibility-control",
    );
  });
});
