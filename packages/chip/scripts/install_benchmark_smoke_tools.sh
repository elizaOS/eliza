#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
prefix="$repo_dir/.venv/bin"
lmbench_bin_dir=""
host_smoke_marker="eliza-host-smoke"

usage() {
    cat <<'USAGE'
usage: scripts/install_benchmark_smoke_tools.sh [--prefix DIR] [--lmbench-bin-dir DIR]

Installs benchmark command shims into DIR, defaulting to .venv/bin.

Options:
  --prefix DIR           directory to receive command symlinks
  --lmbench-bin-dir DIR  directory containing real built bw_mem and lat_mem_rd
  --help                 show this help

Without --lmbench-bin-dir, bw_mem and lat_mem_rd are linked to repo-local host
smoke tools. With --lmbench-bin-dir, they are linked to real executables from
that directory and rejected if they contain the repo host-smoke marker.
USAGE
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --prefix)
            [ "$#" -ge 2 ] || { echo "missing value for --prefix" >&2; exit 2; }
            prefix="$2"
            shift 2
            ;;
        --lmbench-bin-dir)
            [ "$#" -ge 2 ] || { echo "missing value for --lmbench-bin-dir" >&2; exit 2; }
            lmbench_bin_dir="$2"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

mkdir -p "$prefix"

install_link() {
    src="$1"
    dst="$2"
    [ -x "$src" ] || { echo "not executable: $src" >&2; exit 2; }
    ln -sf "$src" "$dst"
}

for tool in coremark stream_c.exe benchmark_model; do
    chmod +x "$repo_dir/benchmarks/tools/$tool"
    install_link "$repo_dir/benchmarks/tools/$tool" "$prefix/$tool"
done

if [ -n "$lmbench_bin_dir" ]; then
    lmbench_bin_dir="$(CDPATH=; cd -- "$lmbench_bin_dir" && pwd)"
    for tool in bw_mem lat_mem_rd; do
        src="$lmbench_bin_dir/$tool"
        [ -x "$src" ] || { echo "missing executable lmbench tool: $src" >&2; exit 2; }
        if grep -aq "$host_smoke_marker" "$src"; then
            echo "refusing repo-local host smoke lmbench tool: $src" >&2
            exit 2
        fi
        install_link "$src" "$prefix/$tool"
    done
    echo "installed benchmark smoke tools and real lmbench tools into $prefix"
else
    for tool in bw_mem lat_mem_rd; do
        chmod +x "$repo_dir/benchmarks/tools/$tool"
        install_link "$repo_dir/benchmarks/tools/$tool" "$prefix/$tool"
    done
    echo "installed benchmark smoke tools into $prefix"
fi
echo "note: coremark and stream_c.exe from benchmarks/tools are host smoke shims; strict release runs require real CoreMark/STREAM executables"
