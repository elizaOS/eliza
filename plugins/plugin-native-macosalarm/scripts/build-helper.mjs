#!/usr/bin/env node
/**
 * Builds the macOS alarm helper with a content- and architecture-aware cache.
 * The tracked helper may be reused only when its source stamp and Mach-O slice
 * both match the current Node target; this keeps Intel and Apple Silicon
 * release artifacts from packaging an incompatible thin binary.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const source = resolve(pkgRoot, "swift-helper", "main.swift");
const outDir = resolve(pkgRoot, "bin");
const outBin = resolve(outDir, "macosalarm-helper");
const outStamp = resolve(outDir, "macosalarm-helper.source.sha256");
const moduleCacheDir = resolve(pkgRoot, ".swift-module-cache");
const tempDir = join(moduleCacheDir, "tmp");
const verbosePluginBuild = process.env.ELIZA_VERBOSE_PLUGIN_BUILD === "1";
const forceHelperBuild =
  process.env.ELIZA_MACOSALARM_FORCE_HELPER_BUILD === "1";

const MACHO_CPU_TYPES = {
  arm64: 0x0100000c,
  x64: 0x01000007,
};

const THIN_MAGICS = new Map([
  ["cefaedfe", "le"],
  ["cffaedfe", "le"],
  ["feedface", "be"],
  ["feedfacf", "be"],
]);

const FAT_MAGICS = new Map([
  ["cafebabe", { endian: "be", entrySize: 20 }],
  ["cafebabf", { endian: "be", entrySize: 32 }],
  ["bebafeca", { endian: "le", entrySize: 20 }],
  ["bfbafeca", { endian: "le", entrySize: 32 }],
]);

function readUInt32(bytes, offset, endian) {
  return endian === "le"
    ? bytes.readUInt32LE(offset)
    : bytes.readUInt32BE(offset);
}

/** Returns the CPU types declared by a thin or universal Mach-O header. */
export function readMachOCpuTypes(bytes) {
  if (bytes.length < 8) return [];

  const magic = bytes.subarray(0, 4).toString("hex");
  const thinEndian = THIN_MAGICS.get(magic);
  if (thinEndian) return [readUInt32(bytes, 4, thinEndian)];

  const fat = FAT_MAGICS.get(magic);
  if (!fat) return [];

  const sliceCount = readUInt32(bytes, 4, fat.endian);
  const headerBytes = 8 + sliceCount * fat.entrySize;
  if (sliceCount === 0 || !Number.isSafeInteger(headerBytes)) return [];
  if (headerBytes > bytes.length) return [];

  const cpuTypes = [];
  for (let index = 0; index < sliceCount; index += 1) {
    cpuTypes.push(readUInt32(bytes, 8 + index * fat.entrySize, fat.endian));
  }
  return cpuTypes;
}

/** Checks whether a Mach-O binary contains the requested Node architecture. */
export function helperSupportsArchitecture(binaryPath, targetArch) {
  const cpuType = MACHO_CPU_TYPES[targetArch];
  if (cpuType === undefined || !existsSync(binaryPath)) return false;
  return readMachOCpuTypes(readFileSync(binaryPath)).includes(cpuType);
}

/** Applies every cache-validity condition without invoking the compiler. */
export function helperCacheIsCurrent({
  binaryPath,
  stampPath,
  expectedStamp,
  targetArch,
}) {
  if (!existsSync(binaryPath) || !existsSync(stampPath)) return false;
  const stamped = readFileSync(stampPath, "utf8").trim();
  return (
    stamped === expectedStamp &&
    helperSupportsArchitecture(binaryPath, targetArch)
  );
}

// Flags that change the emitted binary. Deliberately excludes the absolute
// paths in the swiftc argv (module cache, output) — those vary per checkout,
// and this stamp is tracked, so folding them in would make the file differ on
// every machine and destroy its value as a drift guard.
const COMPILE_FLAGS = ["-O"];

const sourceHash = createHash("sha256")
  .update(readFileSync(source))
  .update("\0")
  .update(COMPILE_FLAGS.join(" "))
  .digest("hex");

export function buildHelper() {
  if (process.platform !== "darwin") {
    console.warn(
      `[macosalarm] skipping swift helper build on ${process.platform}`,
    );
    return;
  }

  if (!existsSync(source)) {
    throw new Error(`macosalarm swift source missing: ${source}`);
  }

  // Keyed on source content and stable compile flags, then separately checked
  // for a compatible Mach-O slice. The tracked ARM64 helper must never satisfy
  // the cache on an Intel release runner merely because its stamp matches.
  if (
    !forceHelperBuild &&
    helperCacheIsCurrent({
      binaryPath: outBin,
      stampPath: outStamp,
      expectedStamp: sourceHash,
      targetArch: process.arch,
    })
  ) {
    if (verbosePluginBuild) {
      console.log(`[macosalarm] helper already current: ${outBin}`);
    }
    return;
  }

  mkdirSync(outDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });

  const result = spawnSync(
    "swiftc",
    [
      source,
      ...COMPILE_FLAGS,
      "-module-cache-path",
      moduleCacheDir,
      "-o",
      outBin,
    ],
    {
      env: {
        ...process.env,
        // Keep compiler caches inside the package so sandboxed/local builds do
        // not need write access to ~/.cache/clang.
        CLANG_MODULE_CACHE_PATH:
          process.env.CLANG_MODULE_CACHE_PATH ?? moduleCacheDir,
        TMPDIR: process.env.TMPDIR ?? tempDir,
      },
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error(`swiftc failed with status ${result.status ?? "unknown"}`);
  }

  if (!helperSupportsArchitecture(outBin, process.arch)) {
    throw new Error(
      `swiftc produced a helper without a ${process.arch} Mach-O slice: ${outBin}`,
    );
  }

  // Write the stamp only after checking the emitted artifact. A failed or
  // wrong-target compiler invocation must not make the next build skip.
  writeFileSync(outStamp, `${sourceHash}\n`);

  if (verbosePluginBuild) {
    console.log(`[macosalarm] built ${outBin}`);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  buildHelper();
}
