#!/usr/bin/env bash
# Installs checksum-pinned gitleaks for the current supported runner.
#
# Single source of truth for the gitleaks version and SHA256 consumed by
# ci.yml, gitleaks.yml, and test.yml — bump every consumer by editing this
# file. Hashes come from the upstream gitleaks_<version>_checksums.txt
# release asset; verify against it on every version bump.

set -euo pipefail

GITLEAKS_VERSION="8.30.1"
destination="${1:-${RUNNER_TEMP:-/tmp}/gitleaks-bin}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    gitleaks_asset="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
    gitleaks_sha="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
    ;;
  Linux-aarch64|Linux-arm64)
    gitleaks_asset="gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz"
    gitleaks_sha="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
    ;;
  Darwin-x86_64)
    gitleaks_asset="gitleaks_${GITLEAKS_VERSION}_darwin_x64.tar.gz"
    gitleaks_sha="dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709"
    ;;
  Darwin-arm64)
    gitleaks_asset="gitleaks_${GITLEAKS_VERSION}_darwin_arm64.tar.gz"
    gitleaks_sha="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"
    ;;
  *)
    printf 'unsupported gitleaks host: %s-%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

mkdir -p "$destination"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

gitleaks_archive="$scratch/$gitleaks_asset"
curl --fail --location --silent --show-error --retry 3 \
  --output "$gitleaks_archive" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${gitleaks_asset}"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$gitleaks_archive" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$gitleaks_archive" | awk '{print $1}')"
fi
if [[ "$actual" != "$gitleaks_sha" ]]; then
  printf 'checksum mismatch for gitleaks: expected %s, got %s\n' "$gitleaks_sha" "$actual" >&2
  exit 1
fi

tar -xzf "$gitleaks_archive" -C "$scratch" gitleaks
install -m 0755 "$scratch/gitleaks" "$destination/gitleaks"
printf '%s\n' "$destination"
