/**
 * Packaging contract for the macOS Accessibility-first Computer Use helper.
 *
 * Direct/full Darwin desktop builds compile the tracked Swift source before
 * runtime staging and verify that generated, staged, and bundled copies are an
 * executable Mach-O for the target architecture. Other platforms keep the
 * TypeScript fail-closed surface without attempting to build a macOS helper.
 */

import fs from "node:fs";
import path from "node:path";

const MACHO_64_MAGIC_LE = 0xfeedfacf;
const MACHO_CPU_TYPE = {
  arm64: 0x0100000c,
  x64: 0x01000007,
};

export function shouldPackageNativeComputerUse({
  platform,
  buildVariant,
  buildProfile,
  cloudOnly,
}) {
  return (
    platform === "darwin" &&
    buildVariant === "direct" &&
    buildProfile === "full" &&
    cloudOnly !== true
  );
}

export function nativeComputerUseSourceBinary(root) {
  return path.join(
    root,
    "plugins",
    "plugin-computeruse",
    "native",
    "macos",
    "accessibility-control",
  );
}

export function nativeComputerUseStagedBinary(root) {
  return path.join(
    root,
    "dist",
    "node_modules",
    "@elizaos",
    "plugin-computeruse",
    "native",
    "macos",
    "accessibility-control",
  );
}

export function nativeComputerUseBundleBinary(appBundlePath) {
  return path.join(
    appBundlePath,
    "Contents",
    "Resources",
    "app",
    "eliza-dist",
    "node_modules",
    "@elizaos",
    "plugin-computeruse",
    "native",
    "macos",
    "accessibility-control",
  );
}

export function verifyNativeComputerUseBinary(
  binaryPath,
  { arch, label = "native Computer Use Accessibility helper" },
) {
  const expectedCpuType = MACHO_CPU_TYPE[arch];
  if (!expectedCpuType) {
    throw new Error(`Unsupported macOS Computer Use architecture: ${arch}`);
  }

  const stat = fs.statSync(binaryPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${label} is missing: ${binaryPath}`);
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`${label} is not executable: ${binaryPath}`);
  }

  const fd = fs.openSync(binaryPath, "r");
  try {
    const header = Buffer.alloc(8);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) {
      throw new Error(`${label} has a truncated Mach-O header: ${binaryPath}`);
    }
    const magic = header.readUInt32LE(0);
    const cpuType = header.readUInt32LE(4);
    if (magic !== MACHO_64_MAGIC_LE) {
      throw new Error(`${label} is not a 64-bit Mach-O binary: ${binaryPath}`);
    }
    if (cpuType !== expectedCpuType) {
      throw new Error(
        `${label} architecture mismatch: expected ${arch}, found cpuType=0x${cpuType.toString(16)}`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }

  return { path: binaryPath, arch, size: stat.size, mode: stat.mode & 0o777 };
}
