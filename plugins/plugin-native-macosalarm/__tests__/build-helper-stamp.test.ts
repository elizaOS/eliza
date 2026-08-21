/**
 * The helper binary and its Swift source are both tracked, and git assigns every
 * file the checkout time. Deciding whether to run `swiftc` by comparing their
 * mtimes therefore turned the desktop build into a coin flip on a fresh clone or
 * worktree — measured at 2 ms apart, in an order nothing guarantees, which on a
 * machine with a drifted Swift toolchain is the difference between a working
 * build and a hard failure (#23776).
 *
 * These tests pin the decision to the source's content and the helper's Mach-O
 * architecture instead.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  helperCacheIsCurrent,
  readMachOCpuTypes,
} from "../scripts/build-helper.mjs";

const pkgRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const script = path.join(pkgRoot, "scripts", "build-helper.mjs");
const source = path.join(pkgRoot, "swift-helper", "main.swift");
const stamp = path.join(pkgRoot, "bin", "macosalarm-helper.source.sha256");

const COMPILE_FLAGS = ["-O"];
const CPU_X86_64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;

type Endian = "le" | "be";
type MachOBits = 32 | 64;

const THIN_MAGICS: Record<`${MachOBits}-${Endian}`, string> = {
  "32-le": "cefaedfe",
  "64-le": "cffaedfe",
  "32-be": "feedface",
  "64-be": "feedfacf",
};

const FAT_MAGICS: Record<`${MachOBits}-${Endian}`, string> = {
  "32-le": "bebafeca",
  "64-le": "bfbafeca",
  "32-be": "cafebabe",
  "64-be": "cafebabf",
};

function writeUInt32(
  bytes: Buffer,
  value: number,
  offset: number,
  endian: Endian,
): void {
  if (endian === "le") bytes.writeUInt32LE(value, offset);
  else bytes.writeUInt32BE(value, offset);
}

function writeUInt64(
  bytes: Buffer,
  value: bigint,
  offset: number,
  endian: Endian,
): void {
  if (endian === "le") bytes.writeBigUInt64LE(value, offset);
  else bytes.writeBigUInt64BE(value, offset);
}

function thinMachO(
  cpuType: number,
  bits: MachOBits = 64,
  endian: Endian = "le",
): Buffer {
  const bytes = Buffer.alloc(bits === 32 ? 28 : 32);
  Buffer.from(THIN_MAGICS[`${bits}-${endian}`], "hex").copy(bytes);
  writeUInt32(bytes, cpuType, 4, endian);
  return bytes;
}

function universalMachO(
  cpuTypes: number[],
  bits: MachOBits = 32,
  endian: Endian = "be",
): Buffer {
  const entrySize = bits === 32 ? 20 : 32;
  const slices = cpuTypes.map((cpuType) => thinMachO(cpuType));
  const headerSize = 8 + cpuTypes.length * entrySize;
  const bytes = Buffer.alloc(
    headerSize + slices.reduce((total, slice) => total + slice.length, 0),
  );
  Buffer.from(FAT_MAGICS[`${bits}-${endian}`], "hex").copy(bytes);
  writeUInt32(bytes, cpuTypes.length, 4, endian);
  let sliceOffset = headerSize;
  for (const [index, cpuType] of cpuTypes.entries()) {
    const entryOffset = 8 + index * entrySize;
    const slice = slices[index];
    writeUInt32(bytes, cpuType, entryOffset, endian);
    if (bits === 32) {
      writeUInt32(bytes, sliceOffset, entryOffset + 8, endian);
      writeUInt32(bytes, slice.length, entryOffset + 12, endian);
    } else {
      writeUInt64(bytes, BigInt(sliceOffset), entryOffset + 8, endian);
      writeUInt64(bytes, BigInt(slice.length), entryOffset + 16, endian);
    }
    slice.copy(bytes, sliceOffset);
    sliceOffset += slice.length;
  }
  return bytes;
}

function expectedStamp(): string {
  return createHash("sha256")
    .update(readFileSync(source))
    .update("\0")
    .update(COMPILE_FLAGS.join(" "))
    .digest("hex");
}

/**
 * Returns whether the build SKIPPED swiftc, not merely whether it exited 0.
 * Exit status alone cannot tell the two apart, so a status-only assertion
 * passes against the very mtime logic it is supposed to pin.
 */
function runBuildSkipped(): boolean {
  const result = spawnSync(process.execPath, [script], {
    cwd: pkgRoot,
    encoding: "utf8",
    env: { ...process.env, ELIZA_VERBOSE_PLUGIN_BUILD: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`build-helper exited ${result.status}: ${result.stderr}`);
  }
  return (result.stdout ?? "").includes("helper already current");
}

/** Force an mtime ordering without touching content. */
function makeNewest(target: string): void {
  const future = new Date(Date.now() + 10_000);
  utimesSync(target, future, future);
}

describe("Mach-O architecture cache validity", () => {
  it("reads thin 32-bit and 64-bit headers in both byte orders", () => {
    for (const bits of [32, 64] as const) {
      for (const endian of ["le", "be"] as const) {
        expect(readMachOCpuTypes(thinMachO(CPU_ARM64, bits, endian))).toEqual([
          CPU_ARM64,
        ]);
      }
    }
  });

  it("reads fat 32-bit and 64-bit tables in both byte orders", () => {
    for (const bits of [32, 64] as const) {
      for (const endian of ["le", "be"] as const) {
        expect(
          readMachOCpuTypes(
            universalMachO([CPU_X86_64, CPU_ARM64], bits, endian),
          ),
        ).toEqual([CPU_X86_64, CPU_ARM64]);
      }
    }
  });

  it("rejects truncated thin headers", () => {
    for (const bits of [32, 64] as const) {
      const thin = thinMachO(CPU_ARM64, bits);
      expect(readMachOCpuTypes(thin.subarray(0, thin.length - 1))).toEqual([]);
    }
  });

  it("rejects fat headers without complete tables or slice payloads", () => {
    const complete = universalMachO([CPU_ARM64]);
    expect(readMachOCpuTypes(complete.subarray(0, 8))).toEqual([]);
    expect(readMachOCpuTypes(complete.subarray(0, 28))).toEqual([]);
  });

  it("rejects zero-sized, out-of-range, and unsafe fat slices", () => {
    const zeroSized = universalMachO([CPU_ARM64]);
    zeroSized.writeUInt32BE(0, 20);
    expect(readMachOCpuTypes(zeroSized)).toEqual([]);

    const outOfRange = universalMachO([CPU_ARM64]);
    outOfRange.writeUInt32BE(outOfRange.length, 16);
    expect(readMachOCpuTypes(outOfRange)).toEqual([]);

    const unsafe = universalMachO([CPU_ARM64], 64);
    unsafe.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 16);
    expect(readMachOCpuTypes(unsafe)).toEqual([]);
  });

  it("rejects fat entries whose referenced thin slice has another CPU type", () => {
    const mismatched = universalMachO([CPU_ARM64]);
    mismatched.writeUInt32BE(CPU_X86_64, 8);
    expect(readMachOCpuTypes(mismatched)).toEqual([]);
  });

  it("rejects a matching source stamp when the helper slice is wrong", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "macosalarm-arch-"));
    const binaryPath = path.join(directory, "helper");
    const stampPath = path.join(directory, "helper.source.sha256");
    try {
      writeFileSync(stampPath, "same-source-and-flags\n");
      writeFileSync(binaryPath, thinMachO(CPU_ARM64));

      expect(
        helperCacheIsCurrent({
          binaryPath,
          stampPath,
          expectedStamp: "same-source-and-flags",
          targetArch: "x64",
        }),
      ).toBe(false);
      expect(
        helperCacheIsCurrent({
          binaryPath,
          stampPath,
          expectedStamp: "same-source-and-flags",
          targetArch: "arm64",
        }),
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const onDarwin = process.platform === "darwin" ? describe : describe.skip;

onDarwin("build-helper currency check", () => {
  it("stamps the committed binary with the committed source's hash", () => {
    // If these drift, the build silently ships a binary that does not match its
    // source — the failure mode a content check has to avoid introducing.
    expect(readFileSync(stamp, "utf8").trim()).toBe(expectedStamp());
  });

  it("reaches the same decision whichever file git wrote first", () => {
    // This is the regression. Under the mtime comparison the first ordering ran
    // `swiftc` and the second skipped it, from byte-identical content. Both must
    // now skip, because the content and flags are unchanged.
    makeNewest(source);
    const sourceNewest = runBuildSkipped();

    makeNewest(path.join(pkgRoot, "bin", "macosalarm-helper"));
    const binaryNewest = runBuildSkipped();

    expect(sourceNewest).toBe(true);
    expect(binaryNewest).toBe(sourceNewest);
  });

  // The stamp keys on what actually determines the emitted binary. Source
  // content is the obvious half; the compile flags are the half an mtime scheme
  // and a source-only hash both miss, so changing -O would silently ship a
  // binary built under different optimization.
  it("rebuilds when a compile flag changes even though the source has not", () => {
    expect(runBuildSkipped()).toBe(true);

    const original = readFileSync(script, "utf8");
    try {
      writeFileSync(
        script,
        original.replace(
          'COMPILE_FLAGS = ["-O"]',
          'COMPILE_FLAGS = ["-Onone"]',
        ),
      );
      expect(runBuildSkipped()).toBe(false);
    } finally {
      writeFileSync(script, original);
      runBuildSkipped();
    }
  }, 60_000);
});
