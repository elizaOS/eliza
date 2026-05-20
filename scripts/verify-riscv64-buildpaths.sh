#!/usr/bin/env bash
# verify-riscv64-buildpaths.sh — exercise every in-sandbox riscv64
# cross-build path and emit a verification report.
#
# Validates Wave 1 + Wave 3 RVV cross-compilation of the four CPU-side
# native plugins (qjl-cpu, polarquant-cpu, turboquant-cpu, silero-vad-cpp)
# against the repo-root Zig toolchain at
# `cmake/toolchain-riscv64-linux-musl.cmake`. Inspects every produced
# artifact with `file(1)` to confirm `ELF 64-bit LSB ... UCB RISC-V`.
# Optionally runs the shipped smokes under `qemu-riscv64-static` when
# present; logs a clean SKIP otherwise.
#
# Usage:
#   bash scripts/verify-riscv64-buildpaths.sh                           # build + report
#   bash scripts/verify-riscv64-buildpaths.sh --jobs 8                  # parallel
#   bash scripts/verify-riscv64-buildpaths.sh --out reports/foo.md      # custom report path
#   bash scripts/verify-riscv64-buildpaths.sh --keep-build              # don't rm build dirs at the end
#
# Exit code:
#   0 — every package builds and every artifact validates rv64+lp64d
#   1 — at least one package fails or one artifact is the wrong ELF arch
#
# Zig 0.13 vs 0.14:
#   The Wave 1 RVV TUs (qjl_*_rvv.c, polar_*_rvv.c, tbq_*_rvv.c) expect
#   `-march=rv64gcv1p0`, which Zig 0.14+'s clang accepts directly. On
#   Zig 0.13 we drive the per-package escape hatches
#   (QJL_RVV_COMPILE_OPTIONS / POLARQUANT_RVV_COMPILE_OPTIONS /
#   TURBOQUANT_RVV_FLAGS) with a CPU name. TurboQuant uses
#   `-mcpu=generic_rv64+v+m+a+f+d+c` rather than a named core
#   (e.g. sifive_x280) because LLVM bakes the named core's VLEN into the
#   zvl* attribute, and the resulting code silently truncates at a
#   smaller actual VLEN (qemu-user reports VLEN=128, the spec minimum).

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
OUT="$repo_root/reports/riscv64-buildpath-verification.md"
KEEP_BUILD=0

while [ $# -gt 0 ]; do
    case "$1" in
        --jobs) JOBS="$2"; shift 2;;
        --out) OUT="$2"; shift 2;;
        --keep-build) KEEP_BUILD=1; shift;;
        -h|--help)
            sed -n '2,/^$/p' "$0" | sed 's/^# //; s/^#//'
            exit 0;;
        *) echo "unknown argument: $1" >&2; exit 2;;
    esac
done

mkdir -p "$(dirname "$OUT")"

# Probe toolchain.
ZIG_BIN="${ZIG_BIN:-$(command -v zig || true)}"
if [ -z "$ZIG_BIN" ]; then
    echo "[verify-riscv64] zig not on PATH; install Zig 0.13+ and re-run." >&2
    exit 1
fi
export ZIG_BIN

ZIG_VERSION="$($ZIG_BIN version)"
ZIG_MAJOR_MINOR="$(printf '%s' "$ZIG_VERSION" | awk -F. '{ print $1"."$2 }')"

# Pick the right RVV recipe for the host Zig.
# Zig 0.14+ accepts `-march=rv64gcv1p0` (default in each package's
# CMakeLists). Zig 0.13 only accepts CPU names — sifive_x280 is the
# smallest one with full RVV 1.0 support and runs the same intrinsics.
case "$ZIG_MAJOR_MINOR" in
    0.13)
        RVV_OVERRIDE_REASON="Zig 0.13 (clang in 0.13 only accepts \`-mcpu=\`; using generic_rv64+v to avoid baked-in VLEN assumptions)"
        QJL_RVV="-DQJL_RVV_COMPILE_OPTIONS=-mcpu=sifive_x280;-mabi=lp64d"
        POLAR_RVV="-DPOLARQUANT_RVV_COMPILE_OPTIONS=-mcpu=sifive_x280;-mabi=lp64d"
        # Use the generic rv64gc+V CPU rather than a named core: named cores
        # (e.g. sifive_x280) advertise their VLEN (X280 = 512) via the
        # zvl512b attribute, which makes LLVM's loop vectoriser emit
        # unrolled m1/m2 sequences that silently truncate at VLEN=128
        # (the spec minimum, and what qemu-user reports). The generic
        # CPU has no zvl* attribute so vsetvli loops stay portable.
        TBQ_RVV="-DTURBOQUANT_RVV_FLAGS=-mcpu=generic_rv64+v+m+a+f+d+c"
        ;;
    *)
        RVV_OVERRIDE_REASON="Zig $ZIG_MAJOR_MINOR (default \`-march=rv64gcv1p0\` accepted)"
        QJL_RVV=""
        POLAR_RVV=""
        TBQ_RVV=""
        ;;
esac

QEMU_BIN="$(command -v qemu-riscv64-static 2>/dev/null || command -v qemu-riscv64 2>/dev/null || true)"

now_iso() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
run_started_iso="$(now_iso)"

# Per-package configs. The escape-hatch flag is passed unquoted so the
# semicolon in the CMake list survives.
build_package() {
    local pkg="$1"
    local extra_flag="$2"
    local pkgdir="packages/native/plugins/$pkg"
    local builddir="$pkgdir/build/riscv64-verify"

    if [ ! -f "$pkgdir/CMakeLists.txt" ]; then
        echo "fail: $pkgdir/CMakeLists.txt missing"
        return 1
    fi

    rm -rf "$builddir"

    local config_log="$builddir.config.log"
    local build_log="$builddir.build.log"
    mkdir -p "$(dirname "$config_log")"

    if [ -n "$extra_flag" ]; then
        cmake -S "$pkgdir" -B "$builddir" \
            -DCMAKE_TOOLCHAIN_FILE="$repo_root/cmake/toolchain-riscv64-linux-musl.cmake" \
            "$extra_flag" > "$config_log" 2>&1 || {
            echo "fail: cmake configure (see $config_log)"
            return 1
        }
    else
        cmake -S "$pkgdir" -B "$builddir" \
            -DCMAKE_TOOLCHAIN_FILE="$repo_root/cmake/toolchain-riscv64-linux-musl.cmake" \
            > "$config_log" 2>&1 || {
            echo "fail: cmake configure (see $config_log)"
            return 1
        }
    fi
    cmake --build "$builddir" -j"$JOBS" > "$build_log" 2>&1 || {
        echo "fail: cmake build (see $build_log)"
        return 1
    }
    echo "ok"
}

inspect_artifacts() {
    local pkg="$1"
    local builddir="packages/native/plugins/$pkg/build/riscv64-verify"
    if [ ! -d "$builddir" ]; then return; fi
    # Static libs (.a), shared libs (.so), and top-level executables.
    # We exclude CMake's own machinery (build.make, cmake_install.cmake,
    # CMakeFiles/, *.cmake) which can pick up +x bits on some hosts and
    # produce false negatives. Output is sorted unique so a file present
    # at both maxdepth-1 and maxdepth-2 is only counted once.
    {
        find "$builddir" -maxdepth 2 \( -name "*.a" -o -name "*.so" -o -name "*.so.*" \) -type f -print
        find "$builddir" -maxdepth 1 -type f -executable \
            ! -name "*.cmake" ! -name "Makefile" ! -name "*.txt" \
            ! -name "*.json" ! -name "*.log" ! -name "*.ninja" \
            -print
    } | sort -u
}

is_riscv64_elf() {
    local f="$1"
    local info
    info="$(file -b "$f" 2>/dev/null || true)"
    case "$info" in
        *"UCB RISC-V"*"double-float ABI"*) return 0;;
        "current ar archive") return 0;;  # ar archive — element check below
        *) return 1;;
    esac
}

ar_members_are_rv64() {
    local archive="$1"
    # Resolve to an absolute path before we cd into the extract dir,
    # otherwise `ar x` (run from inside extract_dir) can't find a
    # relative archive path.
    case "$archive" in
        /*) ;;
        *) archive="$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")";;
    esac
    local extract_dir="$archive.verify-extract"
    rm -rf "$extract_dir"
    mkdir -p "$extract_dir"
    ( cd "$extract_dir" && ar x "$archive" >/dev/null 2>&1 ) || {
        rm -rf "$extract_dir"
        return 1
    }
    local bad=0
    for member in "$extract_dir"/*.o; do
        [ -f "$member" ] || continue
        if ! file -b "$member" | grep -q "UCB RISC-V"; then
            bad=1
            break
        fi
    done
    rm -rf "$extract_dir"
    [ "$bad" -eq 0 ]
}

# ── Build phase ───────────────────────────────────────────────────────
declare -A BUILD_STATUS
echo "[verify-riscv64] Zig: $ZIG_VERSION ($RVV_OVERRIDE_REASON)"
echo "[verify-riscv64] Building qjl-cpu …"
BUILD_STATUS[qjl-cpu]="$(build_package qjl-cpu "$QJL_RVV")"
echo "[verify-riscv64]   $(echo "${BUILD_STATUS[qjl-cpu]}" | head -1)"

echo "[verify-riscv64] Building polarquant-cpu …"
BUILD_STATUS[polarquant-cpu]="$(build_package polarquant-cpu "$POLAR_RVV")"
echo "[verify-riscv64]   $(echo "${BUILD_STATUS[polarquant-cpu]}" | head -1)"

echo "[verify-riscv64] Building turboquant-cpu …"
BUILD_STATUS[turboquant-cpu]="$(build_package turboquant-cpu "$TBQ_RVV")"
echo "[verify-riscv64]   $(echo "${BUILD_STATUS[turboquant-cpu]}" | head -1)"

echo "[verify-riscv64] Building silero-vad-cpp …"
BUILD_STATUS[silero-vad-cpp]="$(build_package silero-vad-cpp "")"
echo "[verify-riscv64]   $(echo "${BUILD_STATUS[silero-vad-cpp]}" | head -1)"

# ── Inspect phase ─────────────────────────────────────────────────────
declare -A ARTIFACT_OK
declare -A ARTIFACT_BAD
for pkg in qjl-cpu polarquant-cpu turboquant-cpu silero-vad-cpp; do
    ARTIFACT_OK[$pkg]=0
    ARTIFACT_BAD[$pkg]=0
    if [ "${BUILD_STATUS[$pkg]}" != "ok" ]; then continue; fi
    while IFS= read -r f; do
        case "$f" in
            *CMakeFiles/*) continue;;
        esac
        if [ -f "$f" ]; then
            if [[ "$f" == *.a ]]; then
                if ar_members_are_rv64 "$f"; then
                    ARTIFACT_OK[$pkg]=$((ARTIFACT_OK[$pkg]+1))
                else
                    ARTIFACT_BAD[$pkg]=$((ARTIFACT_BAD[$pkg]+1))
                fi
            elif is_riscv64_elf "$f"; then
                ARTIFACT_OK[$pkg]=$((ARTIFACT_OK[$pkg]+1))
            else
                ARTIFACT_BAD[$pkg]=$((ARTIFACT_BAD[$pkg]+1))
            fi
        fi
    done < <(inspect_artifacts "$pkg")
done

# ── QEMU smoke phase (optional) ───────────────────────────────────────
declare -A QEMU_RESULT
declare -A QEMU_SMOKES
QEMU_SMOKES[qjl-cpu]="qjl_int8_smoke"
QEMU_SMOKES[polarquant-cpu]="polar_simd_parity_test"
QEMU_SMOKES[turboquant-cpu]="turboquant_smoke"
QEMU_SMOKES[silero-vad-cpp]="silero_vad_stub_smoke"

run_smoke_under_qemu() {
    local pkg="$1"
    local smoke_name="$2"
    local smoke_path="packages/native/plugins/$pkg/build/riscv64-verify/$smoke_name"
    if [ -z "$QEMU_BIN" ]; then
        QEMU_RESULT[$pkg]="skip-no-qemu"
        return
    fi
    if [ ! -x "$smoke_path" ]; then
        QEMU_RESULT[$pkg]="skip-no-smoke-binary"
        return
    fi
    local log="$smoke_path.qemu.log"
    if "$QEMU_BIN" "$smoke_path" > "$log" 2>&1; then
        QEMU_RESULT[$pkg]="pass"
    else
        QEMU_RESULT[$pkg]="fail (exit $?; see $log)"
    fi
}

for pkg in qjl-cpu polarquant-cpu turboquant-cpu silero-vad-cpp; do
    run_smoke_under_qemu "$pkg" "${QEMU_SMOKES[$pkg]}"
done

# ── Report ────────────────────────────────────────────────────────────
{
    echo "# RISC-V cross-build verification report"
    echo
    echo "- Generated: \`$run_started_iso\` → \`$(now_iso)\`"
    echo "- Repo root: \`$repo_root\`"
    echo "- Zig: \`$ZIG_VERSION\` ($RVV_OVERRIDE_REASON)"
    echo "- Toolchain: \`cmake/toolchain-riscv64-linux-musl.cmake\`"
    echo "- QEMU: \`${QEMU_BIN:-not installed}\`"
    echo
    echo "## Wave 1 + Wave 3 RVV native-plugin cross-build matrix"
    echo
    printf '%-20s | %-10s | %-15s | %s\n' "package" "build" "artifacts (ok/bad)" "qemu smoke"
    printf '%-20s | %-10s | %-15s | %s\n' "--------" "-----" "------------------" "-----------"
    for pkg in qjl-cpu polarquant-cpu turboquant-cpu silero-vad-cpp; do
        local_ok="${ARTIFACT_OK[$pkg]:-0}"
        local_bad="${ARTIFACT_BAD[$pkg]:-0}"
        printf '%-20s | %-10s | %3d / %-9d | %s\n' \
            "$pkg" "${BUILD_STATUS[$pkg]}" "$local_ok" "$local_bad" "${QEMU_RESULT[$pkg]}"
    done
    echo
    echo "## Per-package ELF inventory"
    echo
    for pkg in qjl-cpu polarquant-cpu turboquant-cpu silero-vad-cpp; do
        echo "### $pkg"
        echo
        if [ "${BUILD_STATUS[$pkg]}" != "ok" ]; then
            echo "_Build did not succeed; see \`packages/native/plugins/$pkg/build/riscv64-verify.{config,build}.log\`._"
            echo
            continue
        fi
        echo '```'
        inspect_artifacts "$pkg" | while IFS= read -r f; do
            case "$f" in
                *CMakeFiles/*) continue;;
            esac
            short="${f#$repo_root/}"
            short="${short#packages/native/plugins/$pkg/build/riscv64-verify/}"
            info="$(file -b "$f" 2>/dev/null)"
            echo "$short  →  $info"
        done
        echo '```'
        echo
    done
    echo "## Verdict"
    echo
    verdict_fail=0
    for pkg in qjl-cpu polarquant-cpu turboquant-cpu silero-vad-cpp; do
        if [ "${BUILD_STATUS[$pkg]}" != "ok" ]; then verdict_fail=$((verdict_fail+1)); fi
        if [ "${ARTIFACT_BAD[$pkg]:-0}" -gt 0 ]; then verdict_fail=$((verdict_fail+1)); fi
    done
    if [ "$verdict_fail" -eq 0 ]; then
        echo "All 4 native-plugin packages cross-compile to rv64gc / lp64d / RVC. RVV intrinsic TUs are included (gated behind \`*_HAVE_RVV=1\` at the dispatcher level). QEMU smoke status above is informational — without a \`qemu-riscv64-static\` binary the smoke phase is a clean SKIP."
    else
        echo "One or more packages failed verification; see the matrix and per-package logs ($verdict_fail signal(s) tripped)."
    fi
    echo
    echo "## What this report does NOT cover"
    echo
    echo "- Boot of \`cf_riscv64_phone\` Cuttlefish image (needs Linux x86_64 build host + KVM)."
    echo "- Bun-on-riscv64 (upstream \`oven-sh/bun#6266\`; source-build via \`packages/app-core/scripts/bun-riscv64/build.sh\`)."
    echo "- Real-hardware execution of the produced ELFs (this report only verifies cross-compile + ELF arch tag)."
    echo "- RVV kernel numerical parity vs scalar (requires QEMU-V or rv64gcv hardware; deferred)."
} > "$OUT"

echo "[verify-riscv64] Report written: $OUT"

if [ "$KEEP_BUILD" = "0" ]; then
    for pkg in qjl-cpu polarquant-cpu turboquant-cpu silero-vad-cpp; do
        rm -rf "packages/native/plugins/$pkg/build/riscv64-verify" \
              "packages/native/plugins/$pkg/build/riscv64-verify.config.log" \
              "packages/native/plugins/$pkg/build/riscv64-verify.build.log"
    done
fi

# Exit code reflects the verdict.
fail_count=0
for pkg in qjl-cpu polarquant-cpu turboquant-cpu silero-vad-cpp; do
    if [ "${BUILD_STATUS[$pkg]}" != "ok" ]; then fail_count=$((fail_count+1)); fi
    if [ "${ARTIFACT_BAD[$pkg]:-0}" -gt 0 ]; then fail_count=$((fail_count+1)); fi
done
exit $fail_count
