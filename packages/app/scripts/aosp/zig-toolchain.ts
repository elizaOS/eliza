/** Shared Zig ABI selection, version policy, and compiler drivers for native app artifacts. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { compareSemver } from "./compile-libllama-paths.ts";
export const MIN_ZIG_VERSION = "0.13.0";

export const PINNED_ZIG_SERIES_FOR_MUSL_LINK = "0.13";

export const PINNED_ZIG_LINK_TRIPLES = Object.freeze([
  "aarch64-linux-musl",
  "x86_64-linux-musl",
]);

export const ALLOW_UNPINNED_ZIG_ENV = "ELIZA_ALLOW_UNPINNED_ZIG";

export const ABI_TARGETS = [
  {
    androidAbi: "arm64-v8a",
    zigTarget: "aarch64-linux-musl",
    cmakeProcessor: "aarch64",
  },
  {
    androidAbi: "x86_64",
    zigTarget: "x86_64-linux-musl",
    cmakeProcessor: "x86_64",
  },
  {
    androidAbi: "riscv64",
    zigTarget: "riscv64-linux-musl",
    cmakeProcessor: "riscv64",
  },
];

export function zigTriplesForAbis(abis) {
  const triples = new Set();
  for (const abi of abis) {
    const target = ABI_TARGETS.find((t) => t.androidAbi === abi);
    if (!target) {
      throw new Error(
        `[compile-libllama] unknown Android ABI ${abi}; expected one of ${ABI_TARGETS.map(
          (t) => t.androidAbi,
        ).join(", ")}.`,
      );
    }
    triples.add(target.zigTarget);
  }
  return [...triples];
}

export function probeZig({
  spawn = spawnSync,
  platform = process.platform,
} = {}) {
  const probe = spawn("zig", ["version"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0) {
    const installHint =
      platform === "darwin"
        ? "brew install zig"
        : platform === "linux"
          ? "snap install zig --classic --beta\n  or download a tarball from https://ziglang.org/download/ and put `zig` on PATH"
          : "see https://ziglang.org/download/";
    throw new Error(
      `[compile-libllama] zig is required to cross-compile libllama.so for the AOSP build, but was not found on PATH.\n` +
        `Install zig >= ${MIN_ZIG_VERSION} and re-run:\n  ${installHint}\n` +
        `(zig is what we use to produce musl-linked binaries that match the bun-on-Android runtime ABI; ` +
        `the regular Android NDK clang produces bionic-linked binaries that the musl loader cannot dlopen.)`,
    );
  }
  const version = probe.stdout.trim();
  if (compareSemver(version, MIN_ZIG_VERSION) < 0) {
    throw new Error(
      `[compile-libllama] zig ${version} is too old; need >= ${MIN_ZIG_VERSION}.\n` +
        `Earlier zig releases ship libc++ headers that miss the <bit>/<span> shims llama.cpp ` +
        `feature-checks during configure. Upgrade zig and re-run.`,
    );
  }
  return version;
}

export function zigSeries(version) {
  if (typeof version !== "string") return null;
  const parts = version
    .replace(/^v/, "")
    .split(/[-+]/)[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  if (
    parts.length < 2 ||
    !Number.isFinite(parts[0]) ||
    !Number.isFinite(parts[1])
  ) {
    return null;
  }
  return `${parts[0]}.${parts[1]}`;
}

export function assertZigPinForTargets({
  version,
  zigTriples,
  env = process.env,
}) {
  const pinnedTriples = zigTriples.filter((t) =>
    PINNED_ZIG_LINK_TRIPLES.includes(t),
  );
  if (pinnedTriples.length === 0) {
    // No pinned-link triple in this run (e.g. riscv64-only) — nothing to pin.
    return;
  }
  if (env[ALLOW_UNPINNED_ZIG_ENV] === "1") {
    console.warn(
      `[compile-libllama] ${ALLOW_UNPINNED_ZIG_ENV}=1 set; skipping the zig ` +
        `${PINNED_ZIG_SERIES_FOR_MUSL_LINK}.x pin for ${pinnedTriples.join(", ")} ` +
        `(zig ${version}). Only safe if you have verified this zig's lld links ` +
        `aarch64-linux-musl without SIGSEGV.`,
    );
    return;
  }
  const series = zigSeries(version);
  if (series !== PINNED_ZIG_SERIES_FOR_MUSL_LINK) {
    throw new Error(
      `[compile-libllama] zig ${version} (series ${series ?? "unknown"}) is not ` +
        `the pinned zig ${PINNED_ZIG_SERIES_FOR_MUSL_LINK}.x required to link ` +
        `${pinnedTriples.join(", ")}.\n` +
        `zig 0.16's bundled lld SIGSEGVs the aarch64-linux-musl link, aborting ` +
        `the fused/Android build with no actionable diagnostic; zig 0.13.x links ` +
        `it cleanly. Install zig ${PINNED_ZIG_SERIES_FOR_MUSL_LINK}.x and re-run:\n` +
        `  download the 0.13.x tarball from https://ziglang.org/download/ and put ` +
        `\`zig\` on PATH (the package-manager \`zig\` is frequently 0.16).\n` +
        `If you have independently verified your zig's lld links ` +
        `aarch64-linux-musl, override with ${ALLOW_UNPINNED_ZIG_ENV}=1.`,
    );
  }
}

export function ensureZigDrivers({
  cacheDir,
  abi,
  zigBin = "zig",
  riscv64MarchPassthrough = false,
}) {
  const target = ABI_TARGETS.find((t) => t.androidAbi === abi);
  if (!target) {
    throw new Error(`[compile-libllama] Unknown ABI: ${abi}`);
  }
  const driverDir = path.join(cacheDir, "zig-driver", abi);
  fs.mkdirSync(driverDir, { recursive: true });
  const ccPath = path.join(driverDir, "zig-cc");
  const cxxPath = path.join(driverDir, "zig-cxx");

  // riscv64 needs an extra arg-filtering step on Zig 0.13. The vendored
  // llama.cpp's ggml-cpu CMakeLists hardcodes `-march=rv64gc -mabi=lp64d`
  // (and adds extension suffixes when GGML_RVV / GGML_RV_ZFH / etc. are ON).
  // Zig 0.13's bundled LLVM doesn't accept `-march=rv64gc` as a GCC-style
  // ISA string — it tries to translate it to `-mcpu=` and bails with
  // "unknown CPU: 'rv64gc'". The triple `riscv64-linux-musl` already
  // selects the rv64gc/lp64d baseline as Zig's triple-derived CPU, so
  // stripping these flags is byte-for-byte equivalent to the intended
  // build when RVV is OFF.
  //
  // On Zig 0.14+ (`riscv64MarchPassthrough=true`) we leave every
  // `-march=` / `-mabi=` flag alone: Zig 0.14's LLVM accepts the
  // GCC-style ISA string with the full `_zfh_zvfh_zicbop_zihintpause`
  // extension suffix, which is exactly what flips the RVV intrinsic
  // codepaths on in ggml/src/ggml-cpu/arch/riscv/quants.c.
  //
  // Filter logic: walk the argv via the POSIX `set --` idiom (no eval —
  // CMake escapes embedded quotes in -DGGML_VERSION=\"0.12.0\", and a
  // naive `eval exec "..."` collapses them and the C preprocessor sees
  // `0.12.0` as a malformed numeric literal). Each non-stripped arg is
  // re-pushed onto $@ in place; the final `exec "$zig" cc ... "$@"`
  // forwards the whole array with every quote and space preserved.
  const riscv64ArgFilter =
    abi === "riscv64" && !riscv64MarchPassthrough
      ? "_n=$#\n" +
        "i=0\n" +
        "while [ $i -lt $_n ]; do\n" +
        "  arg=$1\n" +
        "  shift\n" +
        "  i=$((i+1))\n" +
        '  case "$arg" in\n' +
        "    -march=rv64gc|-march=rv64gc_*) ;;\n" +
        "    -mabi=lp64d|-mabi=lp64) ;;\n" +
        '    *) set -- "$@" "$arg" ;;\n' +
        "  esac\n" +
        "done\n"
      : null;

  // arm64: the ggml-cpu CMakeLists emits the GCC-style ISA string
  // `-march=armv8.2-a+dotprod+fp16` (from GGML_CPU_ARM_ARCH). Zig 0.13's
  // bundled LLVM rejects that for the aarch64 target — it tries to translate
  // `armv8.2-a` to a `-mcpu=` value and dies with "unknown CPU: 'armv8.2'"
  // (the same class of breakage the riscv64 filter handles). Zig instead
  // speaks `-mcpu=<cpu>+<feature>` with its OWN feature names. Rewrite the
  // GCC `-march=armv8.x-a+...` into the equivalent zig `-mcpu=generic+...`:
  // dotprod→dotprod, i8mm→i8mm, fp16→fullfp16. This sets exactly the same
  // __ARM_FEATURE_DOTPROD / __ARM_FEATURE_MATMUL_INT8 /
  // __ARM_FEATURE_FP16_VECTOR_ARITHMETIC macros (verified), so the live QJL
  // NEON-dotprod / i8mm / fp16 kernel bodies survive preprocessing and the
  // ggml ARM-feature configure probes pass. Any other `-march=` is passed
  // through untouched (there shouldn't be one for arm64).
  const arm64ArgFilter =
    abi === "arm64-v8a"
      ? "_n=$#\n" +
        "i=0\n" +
        "while [ $i -lt $_n ]; do\n" +
        "  arg=$1\n" +
        "  shift\n" +
        "  i=$((i+1))\n" +
        '  case "$arg" in\n' +
        "    -march=armv8.*-a+*)\n" +
        '      _feats=""\n' +
        `      case "$arg" in *+dotprod*) _feats="\${_feats}+dotprod" ;; esac\n` +
        `      case "$arg" in *+i8mm*) _feats="\${_feats}+i8mm" ;; esac\n` +
        `      case "$arg" in *+fp16*) _feats="\${_feats}+fullfp16" ;; esac\n` +
        `      set -- "$@" "-mcpu=generic\${_feats}" ;;\n` +
        '    *) set -- "$@" "$arg" ;;\n' +
        "  esac\n" +
        "done\n"
      : null;

  const argFilter = riscv64ArgFilter ?? arm64ArgFilter;
  const exec =
    argFilter !== null
      ? (subcmd) =>
          argFilter +
          `exec "${zigBin}" ${subcmd} --target=${target.zigTarget} "$@"\n`
      : (subcmd) =>
          `exec "${zigBin}" ${subcmd} --target=${target.zigTarget} "$@"\n`;

  // Quote zigBin so a path with spaces still works. The driver runs under
  // /bin/sh which is POSIX-portable across Linux, macOS, Alpine.
  const ccBody =
    "#!/bin/sh\n" +
    "# Auto-generated by eliza/packages/app/scripts/aosp/compile-libllama.ts.\n" +
    "# Do not edit — regenerated on every build.\n" +
    exec("cc");
  const cxxBody =
    "#!/bin/sh\n" +
    "# Auto-generated by eliza/packages/app/scripts/aosp/compile-libllama.ts.\n" +
    "# Do not edit — regenerated on every build.\n" +
    exec("c++");
  fs.writeFileSync(ccPath, ccBody, "utf8");
  fs.writeFileSync(cxxPath, cxxBody, "utf8");
  fs.chmodSync(ccPath, 0o755);
  fs.chmodSync(cxxPath, 0o755);

  // CMake archives the cross-compiled ELF `.o` files with CMAKE_AR/CMAKE_RANLIB.
  // Its default is the host toolchain's `ar`/`ranlib` — on a macOS build host
  // that is cctools `/usr/bin/ar`, which cannot read aarch64-linux ELF objects:
  // it warns "not a mach-o file" and writes an EMPTY 96-byte archive. libllama.a
  // / libggml*.a then contain zero objects, and the fused libelizainference.so
  // links with every `llama_*` symbol left undefined — text inference silently
  // absent (caught only downstream by verify-fused-symbols). zig bundles
  // llvm-ar/llvm-ranlib, which archive ELF objects on any host, so route
  // CMAKE_AR/RANLIB through `zig ar` / `zig ranlib`. Archiving is object-format
  // agnostic, so these shims need neither `--target` nor the `-march` rewrite.
  const arPath = path.join(driverDir, "zig-ar");
  const ranlibPath = path.join(driverDir, "zig-ranlib");
  const arBody =
    "#!/bin/sh\n" +
    "# Auto-generated by eliza/packages/app/scripts/aosp/compile-libllama.ts.\n" +
    "# Do not edit — regenerated on every build.\n" +
    `exec "${zigBin}" ar "$@"\n`;
  const ranlibBody =
    "#!/bin/sh\n" +
    "# Auto-generated by eliza/packages/app/scripts/aosp/compile-libllama.ts.\n" +
    "# Do not edit — regenerated on every build.\n" +
    `exec "${zigBin}" ranlib "$@"\n`;
  fs.writeFileSync(arPath, arBody, "utf8");
  fs.writeFileSync(ranlibPath, ranlibBody, "utf8");
  fs.chmodSync(arPath, 0o755);
  fs.chmodSync(ranlibPath, 0o755);

  return { ccPath, cxxPath, arPath, ranlibPath };
}
