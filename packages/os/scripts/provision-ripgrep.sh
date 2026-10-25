#!/usr/bin/env bash
# Installs the pinned ripgrep release for GitHub workflow gates when the
# runner image does not already provide it. The downloaded archive is verified
# against the checksum published with the same upstream release.

set -euo pipefail

if command -v rg >/dev/null 2>&1; then
    rg --version
    exit 0
fi

: "${RUNNER_ARCH:?RUNNER_ARCH is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

version=15.1.0
case "${RUNNER_ARCH}" in
    X64) target=x86_64-unknown-linux-musl ;;
    ARM64) target=aarch64-unknown-linux-gnu ;;
    *)
        echo "::error::Unsupported runner architecture for ripgrep: ${RUNNER_ARCH}"
        exit 1
        ;;
esac

archive="ripgrep-${version}-${target}.tar.gz"
release_url="https://github.com/BurntSushi/ripgrep/releases/download/${version}"
install_root="${RUNNER_TEMP}/ripgrep-${version}"
mkdir -p "${install_root}"
# GitHub release downloads can reset the TLS connection before transferring
# bytes. Retry transport errors within a finite budget; checksum failures still
# stop immediately below.
curl_args=(
    --fail --silent --show-error --location
    --retry 3 --retry-delay 2 --retry-all-errors
    --connect-timeout 20 --max-time 120 --retry-max-time 180
)
curl "${curl_args[@]}" "${release_url}/${archive}" -o "${install_root}/${archive}"
curl "${curl_args[@]}" "${release_url}/${archive}.sha256" -o "${install_root}/${archive}.sha256"
(cd "${install_root}" && sha256sum --check "${archive}.sha256")
tar -xzf "${install_root}/${archive}" -C "${install_root}"
bin_dir="${install_root}/ripgrep-${version}-${target}"
echo "${bin_dir}" >> "${GITHUB_PATH}"
"${bin_dir}/rg" --version
