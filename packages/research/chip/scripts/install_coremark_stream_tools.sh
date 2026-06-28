#!/usr/bin/env sh
set -eu

usage() {
    cat <<'EOF'
Usage: scripts/install_coremark_stream_tools.sh [options]

Build and install real CoreMark and STREAM executables into tools/bin without
using the repo-local host smoke shims.

Options:
  --coremark-src DIR  EEMBC CoreMark source checkout containing core_main.c
  --stream-src DIR    STREAM source checkout containing stream.c
  --prefix DIR        install directory (default: tools/bin)
  --cc CC             C compiler (default: ${CC:-cc})
  --cflags FLAGS      extra compiler flags (default: -O2)
  --only NAME         build only coremark or stream
  --check             verify installed tools are executable and not smoke shims
  -h, --help          show this help

If source paths are omitted, the script searches already-vendored checkouts in
external/, third_party/, vendor/, and benchmarks/sources/. It does not download
sources. If no suitable source tree exists, it exits 2 and prints the blocker.
EOF
}

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
prefix="$repo_dir/tools/bin"
cc="${CC:-cc}"
cflags="-O2"
coremark_src=""
stream_src=""
only="all"
check_only=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --coremark-src)
            [ "$#" -ge 2 ] || { echo "missing value for --coremark-src" >&2; exit 64; }
            coremark_src="$2"
            shift 2
            ;;
        --stream-src)
            [ "$#" -ge 2 ] || { echo "missing value for --stream-src" >&2; exit 64; }
            stream_src="$2"
            shift 2
            ;;
        --prefix)
            [ "$#" -ge 2 ] || { echo "missing value for --prefix" >&2; exit 64; }
            prefix="$2"
            shift 2
            ;;
        --cc)
            [ "$#" -ge 2 ] || { echo "missing value for --cc" >&2; exit 64; }
            cc="$2"
            shift 2
            ;;
        --cflags)
            [ "$#" -ge 2 ] || { echo "missing value for --cflags" >&2; exit 64; }
            cflags="$2"
            shift 2
            ;;
        --only)
            [ "$#" -ge 2 ] || { echo "missing value for --only" >&2; exit 64; }
            only="$2"
            shift 2
            ;;
        --check)
            check_only=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "unknown option: $1" >&2
            usage >&2
            exit 64
            ;;
    esac
done

case "$only" in
    all|coremark|stream) ;;
    *) echo "--only must be coremark, stream, or all" >&2; exit 64 ;;
esac

case "$prefix" in
    /*) ;;
    *) prefix="$repo_dir/$prefix" ;;
esac

find_coremark_src() {
    for dir in \
        "$repo_dir/external/coremark" \
        "$repo_dir/external/CoreMark" \
        "$repo_dir/third_party/coremark" \
        "$repo_dir/vendor/coremark" \
        "$repo_dir/benchmarks/sources/coremark"; do
        if [ -f "$dir/core_main.c" ] && [ -f "$dir/coremark.h" ]; then
            printf '%s\n' "$dir"
            return 0
        fi
    done
    return 1
}

find_stream_src() {
    for dir in \
        "$repo_dir/external/stream" \
        "$repo_dir/external/STREAM" \
        "$repo_dir/third_party/stream" \
        "$repo_dir/vendor/stream" \
        "$repo_dir/benchmarks/sources/stream"; do
        if [ -f "$dir/stream.c" ]; then
            printf '%s\n' "$dir"
            return 0
        fi
    done
    return 1
}

check_not_smoke() {
    output="$1"
    name="$2"
    if [ ! -x "$output" ]; then
        echo "BLOCKED: $name was not installed as executable: $output" >&2
        return 1
    fi
    if LC_ALL=C grep -a -q 'eliza-host-smoke' "$output"; then
        echo "BLOCKED: $name resolves to a repo-local host smoke shim, not a real benchmark: $output" >&2
        return 1
    fi
}

build_coremark() {
    src="$1"
    out="$prefix/coremark"
    for required in core_main.c core_list_join.c core_matrix.c core_state.c core_util.c coremark.h; do
        if [ ! -f "$src/$required" ]; then
            echo "BLOCKED: CoreMark source tree is missing $required: $src" >&2
            return 2
        fi
    done

    port_dir=""
    for candidate in linux posix simple; do
        if [ -f "$src/$candidate/core_portme.c" ]; then
            port_dir="$candidate"
            break
        fi
    done
    if [ -z "$port_dir" ]; then
        echo "BLOCKED: CoreMark source tree needs a port with core_portme.c, expected linux/, posix/, or simple/: $src" >&2
        return 2
    fi

    mkdir -p "$prefix"
    # The EEMBC source is compiled directly so the installed path is stable.
    # FLAGS_STR is embedded for auditability in CoreMark output.
    flags_str="$cc $cflags -DPERFORMANCE_RUN=1 -DITERATIONS=0"
    # shellcheck disable=SC2086
    if ! "$cc" $cflags \
        -DPERFORMANCE_RUN=1 \
        -DITERATIONS=0 \
        "-DFLAGS_STR=\"$flags_str\"" \
        -I"$src" \
        -I"$src/$port_dir" \
        "$src/core_main.c" \
        "$src/core_list_join.c" \
        "$src/core_matrix.c" \
        "$src/core_state.c" \
        "$src/core_util.c" \
        "$src/$port_dir/core_portme.c" \
        -o "$out"; then
        echo "BLOCKED: CoreMark compile failed with $cc; check compiler, port directory, and target flags." >&2
        return 2
    fi
    chmod +x "$out"
    check_not_smoke "$out" CoreMark
    echo "installed real CoreMark executable: ${out#"$repo_dir"/}"
}

build_stream() {
    src="$1"
    out="$prefix/stream_c.exe"
    if [ ! -f "$src/stream.c" ]; then
        echo "BLOCKED: STREAM source tree is missing stream.c: $src" >&2
        return 2
    fi
    mkdir -p "$prefix"
    # shellcheck disable=SC2086
    if ! "$cc" $cflags "$src/stream.c" -o "$out"; then
        echo "BLOCKED: STREAM compile failed with $cc; check compiler and target flags." >&2
        return 2
    fi
    chmod +x "$out"
    check_not_smoke "$out" STREAM
    echo "installed real STREAM executable: ${out#"$repo_dir"/}"
}

if [ "$check_only" -eq 1 ]; then
    rc=0
    if [ "$only" = all ] || [ "$only" = coremark ]; then
        check_not_smoke "$prefix/coremark" CoreMark || rc=2
    fi
    if [ "$only" = all ] || [ "$only" = stream ]; then
        check_not_smoke "$prefix/stream_c.exe" STREAM || rc=2
    fi
    exit "$rc"
fi

if [ "$only" = all ] || [ "$only" = coremark ]; then
    if [ -z "$coremark_src" ]; then
        coremark_src="$(find_coremark_src || true)"
    fi
    if [ -z "$coremark_src" ]; then
        echo "BLOCKED: no vendored CoreMark source checkout found." >&2
        echo "Provide EEMBC CoreMark with --coremark-src DIR or vendor it under external/coremark." >&2
        exit 2
    fi
    case "$coremark_src" in /*) ;; *) coremark_src="$repo_dir/$coremark_src" ;; esac
    build_coremark "$coremark_src"
fi

if [ "$only" = all ] || [ "$only" = stream ]; then
    if [ -z "$stream_src" ]; then
        stream_src="$(find_stream_src || true)"
    fi
    if [ -z "$stream_src" ]; then
        echo "BLOCKED: no vendored STREAM source checkout found." >&2
        echo "Provide STREAM with --stream-src DIR or vendor it under external/stream." >&2
        exit 2
    fi
    case "$stream_src" in /*) ;; *) stream_src="$repo_dir/$stream_src" ;; esac
    build_stream "$stream_src"
fi
