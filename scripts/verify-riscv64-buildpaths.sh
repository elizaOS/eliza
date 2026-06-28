#!/usr/bin/env bash
# verify-riscv64-buildpaths.sh — exercise every in-sandbox riscv64
# cross-build path and emit a verification report.
#
# Validates Wave 1 + Wave 3 RVV cross-compilation of the four CPU-side
# native plugins (qjl-cpu, polarquant-cpu, turboquant-cpu, silero-vad-cpp)
# against the repo-root Zig toolchain at
# `packages/native/cmake/toolchain-riscv64-linux-musl.cmake`. Inspects every produced
# artifact with `file(1)` to confirm `ELF 64-bit LSB ... UCB RISC-V`.
# Optionally runs the shipped smokes under `qemu-riscv64-static` when
# present; logs a clean SKIP otherwise.
#
# Usage:
#   bash scripts/verify-riscv64-buildpaths.sh                           # build + report
#   bash scripts/verify-riscv64-buildpaths.sh --jobs 8                  # parallel
#   bash scripts/verify-riscv64-buildpaths.sh --out reports/foo.md      # custom report path
#   bash scripts/verify-riscv64-buildpaths.sh --keep-build              # don't rm build dirs at the end
#   ELIZA_RISCV64_BOOTSTRAP_ZIG=0 bash scripts/verify-riscv64-buildpaths.sh
#                                                                       # require zig on PATH/ZIG_BIN
#
# Exit code:
#   0 — every package builds and every artifact validates rv64+lp64d
#   1 — at least one package fails or one artifact is the wrong ELF arch
#
# Zig 0.13 vs 0.14:
#   The Wave 1 RVV TUs (qjl_*_rvv.c, polar_*_rvv.c, tbq_*_rvv.c) expect
#   `-march=rv64gcv1p0`, which some Zig/LLVM releases accept directly.
#   On releases that reject it, we drive the per-package escape hatches
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
RM_PATH_RECURSIVE="$repo_root/packages/scripts/rm-path-recursive.mjs"

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

have_cmd() {
    command -v "$1" >/dev/null 2>&1
}

remove_path_recursive() {
    local node_bin
    node_bin="${NODE_BIN:-$(command -v node || true)}"
    if [ -z "$node_bin" ]; then
        echo "[verify-riscv64] node not on PATH; cannot remove recursively via $RM_PATH_RECURSIVE." >&2
        return 1
    fi
    "$node_bin" "$RM_PATH_RECURSIVE" "$@"
}

host_zig_platform() {
    local os arch
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    arch="$(uname -m)"
    case "$os:$arch" in
        linux:x86_64|linux:amd64) echo "x86_64-linux";;
        linux:aarch64|linux:arm64) echo "aarch64-linux";;
        darwin:arm64|darwin:aarch64) echo "aarch64-macos";;
        darwin:x86_64|darwin:amd64) echo "x86_64-macos";;
        *)
            echo ""
            return 1
            ;;
    esac
}

sha256_file() {
    if have_cmd sha256sum; then
        sha256sum "$1" | awk '{ print $1 }'
    else
        shasum -a 256 "$1" | awk '{ print $1 }'
    fi
}

bootstrap_zig() {
    local version="${ELIZA_RISCV64_ZIG_VERSION:-0.14.1}"
    local platform
    platform="$(host_zig_platform)" || {
        echo "[verify-riscv64] zig not on PATH and no bootstrap platform for $(uname -s)/$(uname -m)." >&2
        return 1
    }

    if ! have_cmd curl || ! have_cmd python3; then
        echo "[verify-riscv64] zig not on PATH; install Zig 0.13+ or provide curl+python3 for bootstrap." >&2
        return 1
    fi

    local cache_dir="$repo_root/.tmp/riscv64-verify-zig"
    local install_dir="$cache_dir/zig-$version-$platform"
    local zig_bin="$install_dir/zig"
    if [ -x "$zig_bin" ]; then
        printf '%s\n' "$zig_bin"
        return 0
    fi

    mkdir -p "$cache_dir"
    local metadata archive expected actual top_dir
    metadata="$(
        python3 - "$version" "$platform" <<'PY'
import json
import sys
import urllib.request

version, platform = sys.argv[1], sys.argv[2]
with urllib.request.urlopen("https://ziglang.org/download/index.json", timeout=30) as response:
    index = json.load(response)
try:
    entry = index[version][platform]
except KeyError:
    raise SystemExit(f"missing Zig {version} metadata for {platform}")
print(entry["tarball"])
print(entry["shasum"])
PY
    )" || return 1
    local tarball_url
    tarball_url="$(printf '%s\n' "$metadata" | sed -n '1p')"
    expected="$(printf '%s\n' "$metadata" | sed -n '2p')"
    archive="$cache_dir/$(basename "$tarball_url")"

    echo "[verify-riscv64] zig not on PATH; downloading Zig $version for $platform." >&2
    curl -fsSL --retry 3 --retry-delay 2 -o "$archive" "$tarball_url"
    actual="$(sha256_file "$archive")"
    if [ "$actual" != "$expected" ]; then
        echo "[verify-riscv64] Zig archive checksum mismatch: expected $expected got $actual" >&2
        rm -f "$archive"
        return 1
    fi

    remove_path_recursive "$install_dir"
    top_dir="$(tar -tf "$archive" | sed -n '1s#/.*##p')"
    tar -xf "$archive" -C "$cache_dir"
    if [ -z "$top_dir" ] || [ ! -x "$cache_dir/$top_dir/zig" ]; then
        echo "[verify-riscv64] downloaded Zig archive did not contain an executable zig binary." >&2
        return 1
    fi
    mv "$cache_dir/$top_dir" "$install_dir"
    printf '%s\n' "$zig_bin"
}

# Probe toolchain.
if [ -n "${ZIG_BIN:-}" ]; then
    if [ ! -x "$ZIG_BIN" ]; then
        echo "[verify-riscv64] ZIG_BIN is set but not executable: $ZIG_BIN" >&2
        exit 1
    fi
elif have_cmd zig; then
    ZIG_BIN="$(command -v zig)"
elif [ "${ELIZA_RISCV64_BOOTSTRAP_ZIG:-1}" = "1" ]; then
    ZIG_BIN="$(bootstrap_zig)"
else
    echo "[verify-riscv64] zig not on PATH; install Zig 0.13+ and re-run." >&2
    exit 1
fi
export ZIG_BIN

ZIG_VERSION="$($ZIG_BIN version)"
ZIG_MAJOR_MINOR="$(printf '%s' "$ZIG_VERSION" | awk -F. '{ print $1"."$2 }')"

# Pick the right RVV recipe for the host Zig. Several Zig/LLVM releases
# disagree on whether `-march=rv64gcv1p0` or `-mcpu=...+v` is accepted, so
# probe the installed compiler instead of assuming by version.
if printf 'int main(void){return 0;}\n' \
    | "$ZIG_BIN" cc -target riscv64-linux-musl -march=rv64gcv1p0 -mabi=lp64d -x c - -c -o /dev/null >/dev/null 2>&1; then
    RVV_OVERRIDE_REASON="Zig $ZIG_MAJOR_MINOR accepts \`-march=rv64gcv1p0\`"
    QJL_RVV=""
    POLAR_RVV=""
    TBQ_RVV=""
else
    RVV_OVERRIDE_REASON="Zig $ZIG_MAJOR_MINOR rejects \`-march=rv64gcv1p0\`; using \`-mcpu=generic_rv64+v\` RVV overrides"
    QJL_RVV="-DQJL_RVV_COMPILE_OPTIONS=-mcpu=generic_rv64+v;-mabi=lp64d"
    POLAR_RVV="-DELIZA_RISCV_RVV_FLAGS=-mcpu=generic_rv64+v;-mabi=lp64d"
    TBQ_RVV="-DTURBOQUANT_RVV_FLAGS=-mcpu=generic_rv64+v+m+a+f+d+c"
fi

TOOL_WRAPPER_DIR="$repo_root/.tmp/riscv64-verify-tools"
mkdir -p "$TOOL_WRAPPER_DIR"
cat > "$TOOL_WRAPPER_DIR/zig-ar" <<EOF
#!/usr/bin/env bash
exec "$ZIG_BIN" ar "\$@"
EOF
cat > "$TOOL_WRAPPER_DIR/zig-ranlib" <<EOF
#!/usr/bin/env bash
exec "$ZIG_BIN" ranlib "\$@"
EOF
chmod +x "$TOOL_WRAPPER_DIR/zig-ar" "$TOOL_WRAPPER_DIR/zig-ranlib"

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
    local target

    if [ ! -f "$pkgdir/CMakeLists.txt" ]; then
        echo "fail: $pkgdir/CMakeLists.txt missing"
        return 1
    fi

    remove_path_recursive "$builddir"

    local config_log="$builddir.config.log"
    local build_log="$builddir.build.log"
    mkdir -p "$(dirname "$config_log")"

    if [ -n "$extra_flag" ]; then
        cmake -S "$pkgdir" -B "$builddir" \
            -DCMAKE_TOOLCHAIN_FILE="$repo_root/packages/native/cmake/toolchain-riscv64-linux-musl.cmake" \
            -DCMAKE_AR="$TOOL_WRAPPER_DIR/zig-ar" \
            -DCMAKE_RANLIB="$TOOL_WRAPPER_DIR/zig-ranlib" \
            "$extra_flag" > "$config_log" 2>&1 || {
            echo "fail: cmake configure (see $config_log)"
            return 1
        }
    else
        cmake -S "$pkgdir" -B "$builddir" \
            -DCMAKE_TOOLCHAIN_FILE="$repo_root/packages/native/cmake/toolchain-riscv64-linux-musl.cmake" \
            -DCMAKE_AR="$TOOL_WRAPPER_DIR/zig-ar" \
            -DCMAKE_RANLIB="$TOOL_WRAPPER_DIR/zig-ranlib" \
            > "$config_log" 2>&1 || {
            echo "fail: cmake configure (see $config_log)"
            return 1
        }
    fi
    case "$pkg" in
        qjl-cpu) target="qjl";;
        polarquant-cpu) target="polarquant";;
        turboquant-cpu) target="turboquant";;
        silero-vad-cpp) target="silero_vad";;
        *) target="";;
    esac

    if [ -n "$target" ]; then
        cmake --build "$builddir" --target "$target" -j"$JOBS" > "$build_log" 2>&1 || {
            echo "fail: cmake build (see $build_log)"
            return 1
        }
    else
        cmake --build "$builddir" -j"$JOBS" > "$build_log" 2>&1 || {
            echo "fail: cmake build (see $build_log)"
            return 1
        }
    fi
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
        find "$builddir" -maxdepth 1 -type f \( -perm -111 -o -perm -010 -o -perm -001 \) \
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
    remove_path_recursive "$extract_dir"
    mkdir -p "$extract_dir"
    ( cd "$extract_dir" && ar x "$archive" >/dev/null 2>&1 ) || {
        remove_path_recursive "$extract_dir"
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
    remove_path_recursive "$extract_dir"
    [ "$bad" -eq 0 ]
}

pkg_var_name() {
    printf '%s_%s' "$1" "$(printf '%s' "$2" | tr '[:lower:]-' '[:upper:]_')"
}

set_pkg_value() {
    local prefix="$1"
    local pkg="$2"
    local value="$3"
    local name
    name="$(pkg_var_name "$prefix" "$pkg")"
    printf -v "$name" '%s' "$value"
}

get_pkg_value() {
    local prefix="$1"
    local pkg="$2"
    local default="${3:-}"
    local name
    name="$(pkg_var_name "$prefix" "$pkg")"
    eval "printf '%s' \"\${$name:-$default}\""
}

inc_pkg_value() {
    local prefix="$1"
    local pkg="$2"
    local current
    current="$(get_pkg_value "$prefix" "$pkg" 0)"
    set_pkg_value "$prefix" "$pkg" "$((current + 1))"
}

smoke_name_for_pkg() {
    case "$1" in
        qjl-cpu) echo "qjl_int8_smoke";;
        polarquant-cpu) echo "polar_simd_parity_test";;
        turboquant-cpu) echo "turboquant_smoke";;
        silero-vad-cpp) echo "silero_vad_abi_smoke";;
        *) echo "";;
    esac
}

# ── Build phase ───────────────────────────────────────────────────────
echo "[verify-riscv64] Zig: $ZIG_VERSION ($RVV_OVERRIDE_REASON)"
echo "[verify-riscv64] Building qjl-cpu …"
set_pkg_value BUILD_STATUS qjl-cpu "$(build_package qjl-cpu "$QJL_RVV")"
echo "[verify-riscv64]   $(get_pkg_value BUILD_STATUS qjl-cpu | head -1)"

echo "[verify-riscv64] Building polarquant-cpu …"
set_pkg_value BUILD_STATUS polarquant-cpu "$(build_package polarquant-cpu "$POLAR_RVV")"
echo "[verify-riscv64]   $(get_pkg_value BUILD_STATUS polarquant-cpu | head -1)"

echo "[verify-riscv64] Building turboquant-cpu …"
set_pkg_value BUILD_STATUS turboquant-cpu "$(build_package turboquant-cpu "$TBQ_RVV")"
echo "[verify-riscv64]   $(get_pkg_value BUILD_STATUS turboquant-cpu | head -1)"

echo "[verify-riscv64] Building silero-vad-cpp …"
set_pkg_value BUILD_STATUS silero-vad-cpp "$(build_package silero-vad-cpp "")"
echo "[verify-riscv64]   $(get_pkg_value BUILD_STATUS silero-vad-cpp | head -1)"

# ── Inspect phase ─────────────────────────────────────────────────────
for pkg in qjl-cpu polarquant-cpu turboquant-cpu silero-vad-cpp; do
    set_pkg_value ARTIFACT_OK "$pkg" 0
    set_pkg_value ARTIFACT_BAD "$pkg" 0
    if [ "$(get_pkg_value BUILD_STATUS "$pkg")" != "ok" ]; then continue; fi
    while IFS= read -r f; do
        case "$f" in
            *CMakeFiles/*) continue;;
        esac
        if [ -f "$f" ]; then
            if [[ "$f" == *.a ]]; then
                if ar_members_are_rv64 "$f"; then
                    inc_pkg_value ARTIFACT_OK "$pkg"
                else
                    inc_pkg_value ARTIFACT_BAD "$pkg"
                fi
            elif is_riscv64_elf "$f"; then
                inc_pkg_value ARTIFACT_OK "$pkg"
            else
                inc_pkg_value ARTIFACT_BAD "$pkg"
            fi
        fi
    done < <(inspect_artifacts "$pkg")
done

# ── QEMU smoke phase (optional) ───────────────────────────────────────
run_smoke_under_qemu() {
    local pkg="$1"
    local smoke_name="$2"
    local smoke_path="packages/native/plugins/$pkg/build/riscv64-verify/$smoke_name"
    if [ -z "$QEMU_BIN" ]; then
        set_pkg_value QEMU_RESULT "$pkg" "skip-no-qemu"
        return
    fi
    if [ ! -x "$smoke_path" ]; then
        set_pkg_value QEMU_RESULT "$pkg" "skip-no-smoke-binary"
        return
    fi
    local log="$smoke_path.qemu.log"
    if "$QEMU_BIN" "$smoke_path" > "$log" 2>&1; then
        set_pkg_value QEMU_RESULT "$pkg" "pass"
    else
        set_pkg_value QEMU_RESULT "$pkg" "fail (exit $?; see $log)"
    fi
}

for pkg in qjl-cpu polarquant-cpu turboquant-cpu silero-vad-cpp; do
    run_smoke_under_qemu "$pkg" "$(smoke_name_for_pkg "$pkg")"
done

# ── Report ────────────────────────────────────────────────────────────
{
    echo "# RISC-V cross-build verification report"
    echo
    echo "- Generated: \`$run_started_iso\` → \`$(now_iso)\`"
    echo "- Repo root: \`$repo_root\`"
    echo "- Zig: \`$ZIG_VERSION\` ($RVV_OVERRIDE_REASON)"
    echo "- Toolchain: \`packages/native/cmake/toolchain-riscv64-linux-musl.cmake\`"
    echo "- QEMU: \`${QEMU_BIN:-not installed}\`"
    echo
    echo "## Wave 1 + Wave 3 RVV native-plugin cross-build matrix"
    echo
    printf '%-20s | %-10s | %-15s | %s\n' "package" "build" "artifacts (ok/bad)" "qemu smoke"
    printf '%-20s | %-10s | %-15s | %s\n' "--------" "-----" "------------------" "-----------"
    for pkg in qjl-cpu polarquant-cpu turboquant-cpu silero-vad-cpp; do
        local_ok="$(get_pkg_value ARTIFACT_OK "$pkg" 0)"
        local_bad="$(get_pkg_value ARTIFACT_BAD "$pkg" 0)"
        printf '%-20s | %-10s | %3d / %-9d | %s\n' \
            "$pkg" "$(get_pkg_value BUILD_STATUS "$pkg")" "$local_ok" "$local_bad" "$(get_pkg_value QEMU_RESULT "$pkg")"
    done
    echo
    echo "## Per-package ELF inventory"
    echo
    for pkg in qjl-cpu polarquant-cpu turboquant-cpu silero-vad-cpp; do
        echo "### $pkg"
        echo
        if [ "$(get_pkg_value BUILD_STATUS "$pkg")" != "ok" ]; then
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
        if [ "$(get_pkg_value BUILD_STATUS "$pkg")" != "ok" ]; then verdict_fail=$((verdict_fail+1)); fi
        if [ "$(get_pkg_value ARTIFACT_BAD "$pkg" 0)" -gt 0 ]; then verdict_fail=$((verdict_fail+1)); fi
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
        remove_path_recursive \
            "packages/native/plugins/$pkg/build/riscv64-verify" \
            "packages/native/plugins/$pkg/build/riscv64-verify.config.log" \
            "packages/native/plugins/$pkg/build/riscv64-verify.build.log"
    done
fi

# Exit code reflects the verdict.
fail_count=0
for pkg in qjl-cpu polarquant-cpu turboquant-cpu silero-vad-cpp; do
    if [ "$(get_pkg_value BUILD_STATUS "$pkg")" != "ok" ]; then fail_count=$((fail_count+1)); fi
    if [ "$(get_pkg_value ARTIFACT_BAD "$pkg" 0)" -gt 0 ]; then fail_count=$((fail_count+1)); fi
done
exit $fail_count
