#!/usr/bin/env bash
# Installs checksum-pinned workflow linters for the current supported runner.

set -euo pipefail

ACTIONLINT_VERSION="1.7.12"
destination="${1:-${RUNNER_TEMP:-/tmp}/workflow-linters}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    actionlint_asset="actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
    actionlint_sha="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
    ;;
  Linux-aarch64|Linux-arm64)
    actionlint_asset="actionlint_${ACTIONLINT_VERSION}_linux_arm64.tar.gz"
    actionlint_sha="325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6"
    ;;
  Darwin-x86_64)
    actionlint_asset="actionlint_${ACTIONLINT_VERSION}_darwin_amd64.tar.gz"
    actionlint_sha="5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644"
    ;;
  Darwin-arm64)
    actionlint_asset="actionlint_${ACTIONLINT_VERSION}_darwin_arm64.tar.gz"
    actionlint_sha="aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f"
    ;;
  *)
    printf 'unsupported workflow-linter host: %s-%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

mkdir -p "$destination"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

download_and_verify() {
  local url="$1"
  local expected="$2"
  local output="$3"
  curl --fail --location --silent --show-error --retry 3 --output "$output" "$url"
  local actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$output" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$output" | awk '{print $1}')"
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf 'checksum mismatch for %s: expected %s, got %s\n' "$url" "$expected" "$actual" >&2
    exit 1
  fi
}

actionlint_archive="$scratch/$actionlint_asset"
download_and_verify \
  "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${actionlint_asset}" \
  "$actionlint_sha" \
  "$actionlint_archive"

tar -xzf "$actionlint_archive" -C "$scratch" actionlint
install -m 0755 "$scratch/actionlint" "$destination/actionlint"
printf '%s\n' "$destination"
