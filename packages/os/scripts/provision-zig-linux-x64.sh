#!/usr/bin/env bash
# Provision one checksum-pinned Zig release on a Linux x64 Actions runner.
# The cache stores only the upstream archive; every use revalidates its digest
# before extracting into this job's temporary directory.
set -euo pipefail

temporary_archive=""
cleanup() {
    if [ -n "$temporary_archive" ]; then
        rm -f -- "$temporary_archive"
    fi
}
trap cleanup EXIT

version="${1:-}"
case "$version" in
    0.13.0)
        archive_sha256=d45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea
        archive_name="zig-linux-x86_64-${version}.tar.xz"
        ;;
    0.14.0)
        archive_sha256=473ec26806133cf4d1918caf1a410f8403a13d979726a9045b421b685031a982
        archive_name="zig-linux-x86_64-${version}.tar.xz"
        ;;
    0.14.1)
        archive_sha256=24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c
        archive_name="zig-x86_64-linux-${version}.tar.xz"
        ;;
    *)
        echo "unsupported pinned Zig version: ${version:-<empty>}" >&2
        exit 64
        ;;
esac

if [ "${RUNNER_OS:-Linux}" != Linux ] || [ "${RUNNER_ARCH:-X64}" != X64 ]; then
    echo "pinned Zig provisioner supports only Linux X64 runners" >&2
    exit 65
fi
if [ -z "${RUNNER_TEMP:-}" ] || [ -z "${GITHUB_PATH:-}" ]; then
    echo "RUNNER_TEMP and GITHUB_PATH are required" >&2
    exit 66
fi

cache_dir="${HOME}/.cache/elizaos/zig-archives"
archive="${cache_dir}/${archive_name}"
url="https://ziglang.org/download/${version}/${archive_name}"
mkdir -p "$cache_dir"
if [ -L "$archive" ]; then
    echo "refusing a symlinked Zig archive cache entry: $archive" >&2
    exit 67
fi

archive_valid=false
if [ -f "$archive" ] && printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status; then
    archive_valid=true
fi
if [ "$archive_valid" != true ]; then
    temporary_archive="${archive}.tmp.${GITHUB_RUN_ID:-local}.${RANDOM}"
    curl --fail --location --retry 3 --retry-all-errors --output "$temporary_archive" "$url"
    printf '%s  %s\n' "$archive_sha256" "$temporary_archive" | sha256sum --check --status
    mv -f -- "$temporary_archive" "$archive"
    temporary_archive=""
fi
printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status

zig_root="$(mktemp -d "${RUNNER_TEMP}/elizaos-zig-${version}.XXXXXX")"
tar -C "$zig_root" --strip-components=1 -xJf "$archive"
test -x "$zig_root/zig"
test "$($zig_root/zig version)" = "$version"
echo "$zig_root" >> "$GITHUB_PATH"
