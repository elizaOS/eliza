#!/usr/bin/env bash
set -euo pipefail

version=1.7.12
system="$(uname -s)"
machine="$(uname -m)"

case "${system}/${machine}" in
    Linux/x86_64)
        target=linux_amd64
        sha256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
        ;;
    Linux/aarch64|Linux/arm64)
        target=linux_arm64
        sha256=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6
        ;;
    Darwin/x86_64)
        target=darwin_amd64
        sha256=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644
        ;;
    Darwin/arm64)
        target=darwin_arm64
        sha256=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f
        ;;
    *)
        echo "unsupported actionlint host: ${system}/${machine}" >&2
        exit 1
        ;;
esac

temporary_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
work="$(mktemp -d "${temporary_root%/}/elizaos-actionlint.XXXXXX")"
cleanup() {
    case "$work" in
        "${temporary_root%/}"/elizaos-actionlint.*) rm -rf -- "$work" ;;
    esac
}
trap cleanup EXIT

cache_root="${XDG_CACHE_HOME:-${HOME}/.cache}/elizaos/actionlint"
if [ -L "$cache_root" ]; then
    echo "actionlint cache root must not be a symbolic link: $cache_root" >&2
    exit 1
fi
mkdir -p "$cache_root"
archive="${cache_root}/actionlint_${version}_${target}.tar.gz"
if [ -L "$archive" ]; then
    echo "actionlint cache archive must not be a symbolic link: $archive" >&2
    exit 1
fi
url="https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_${target}.tar.gz"
check_sha256() {
    local path="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        test "$(sha256sum "$path" | awk '{print $1}')" = "$sha256"
    elif command -v shasum >/dev/null 2>&1; then
        test "$(shasum -a 256 "$path" | awk '{print $1}')" = "$sha256"
    else
        echo "no SHA-256 verifier is available" >&2
        return 1
    fi
}

if ! check_sha256 "$archive" 2>/dev/null; then
    download="${work}/actionlint.tar.gz"
    curl --fail --location --retry 4 --retry-all-errors --output "$download" "$url"
    check_sha256 "$download"
    install -m 0644 "$download" "$archive"
fi
check_sha256 "$archive"
tar -xzf "$archive" -C "$work" actionlint
install -m 0755 "${work}/actionlint" "${work}/actionlint-bin"
"${work}/actionlint-bin" -version

bin_dir="$(mktemp -d "${temporary_root%/}/elizaos-actionlint-bin.XXXXXX")"
install -m 0755 "${work}/actionlint-bin" "${bin_dir}/actionlint"
if [ -n "${GITHUB_PATH:-}" ]; then
    echo "$bin_dir" >> "$GITHUB_PATH"
else
    echo "actionlint installed at ${bin_dir}/actionlint"
fi
