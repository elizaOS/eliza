/**
 * Packaging contract for the macOS native activity-tracker helper.
 *
 * The helper is generated from Swift source and intentionally gitignored. A
 * direct/full Darwin desktop build must compile it before runtime staging and
 * verify the generated and packaged copies are executable Mach-O binaries for
 * the target architecture.
 */

import fs from "node:fs";
import path from "node:path";

const MACHO_64_MAGIC_LE = 0xfeedfacf;
const MACHO_CPU_TYPE = {
  arm64: 0x0100000c,
  x64: 0x01000007,
};

export function shouldPackageNativeActivityTracker({
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

export function nativeActivityTrackerSourceBinary(root) {
  return path.join(
    root,
    "plugins",
    "plugin-native-activity-tracker",
    "native",
    "macos",
    "activity-collector",
  );
}

export function nativeActivityTrackerStagedBinary(root) {
  return path.join(
    root,
    "dist",
    "node_modules",
    "@elizaos",
    "native-activity-tracker",
    "native",
    "macos",
    "activity-collector",
  );
}

export function nativeActivityTrackerBundleBinary(appBundlePath) {
  return path.join(
    appBundlePath,
    "Contents",
    "Resources",
    "app",
    "eliza-dist",
    "node_modules",
    "@elizaos",
    "native-activity-tracker",
    "native",
    "macos",
    "activity-collector",
  );
}

export function verifyNativeActivityTrackerBinary(
  binaryPath,
  { arch, label = "native activity collector" },
) {
  const expectedCpuType = MACHO_CPU_TYPE[arch];
  if (!expectedCpuType) {
    throw new Error(
      `Unsupported macOS activity-collector architecture: ${arch}`,
    );
  }

  const stat = fs.statSync(binaryPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw new Error(`${label} is missing: ${binaryPath}`);
  }
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
