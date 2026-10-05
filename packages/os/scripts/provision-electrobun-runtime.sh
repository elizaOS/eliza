#!/usr/bin/env bash
set -euo pipefail

version="1.18.1"
release_base="https://github.com/blackboardsh/electrobun/releases/download/v${version}"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/elizaos/electrobun/v${version}"

case "$(uname -s)" in
  Darwin)
    asset_platform="darwin"
    dist_platform="macos"
    ;;
  Linux)
    asset_platform="linux"
    dist_platform="linux"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    asset_platform="win"
    dist_platform="win"
    ;;
  *)
    echo "unsupported Electrobun host: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) asset_arch="arm64" ;;
  x86_64|amd64) asset_arch="x64" ;;
  *)
    echo "unsupported Electrobun architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

if [[ "$asset_platform" == "win" ]]; then
  asset_arch="x64"
fi

case "${asset_platform}-${asset_arch}" in
  darwin-arm64)
    cli_sha="1ef4a4b42a957d3349f491f7fbe53153d1d5f427bacbda340c8d7fadce6b58d9"
    core_sha="474c24f3af26eb5d59ce9fa90483fef2a35974fcdedebb8df969aebc4350e62f"
    cef_sha="d7925825fcfa8d1c576c25fa985fa1b76ad6f28e0c1c95df30cc9f3ebe59753e"
    ;;
  darwin-x64)
    cli_sha="2aecce6e03d0bcaec5c7133f311bca0589f91fc15344af34cc243575992e6e33"
    core_sha="8049f08f7d1dde0d7f536a5f03fec11e2ecd90c7b7edaf33d5e21910846e4df1"
    cef_sha="67415ecde39a769d8fe081d44a8f989d260c5954d2e312468e72207549dc5ef0"
    ;;
  linux-arm64)
    cli_sha="5400656eb636c215d68fce57acbbd4a0180dd2caa0064a58f1e7ac8045e56cc8"
    core_sha="b2ebdb8b372cb5a612299c35bfaea884845c49c187023d3508ee2e56a6de4b20"
    cef_sha="2df9cb0be254b2ac29f804f2501d430eb7159097ad5172ca1177f145d6faef98"
    ;;
  linux-x64)
    cli_sha="7748fdff2a6cb1195bce6d053021700809f6c7e25f261feebd47b57848b2a08a"
    core_sha="e4ed7f151b8e0f89271e1714cc6adb01f295d0472b84d4f592827a8d9a6e14e6"
    cef_sha="17f2951ee13262ae57d8a70641d3ece36d5ab2ee874f0e72ee30885d83830362"
    ;;
  win-x64)
    cli_sha="374eeeb98efa6caf5b5515a67ae587d0b53af690282dc8fb4283e928bdd026a8"
    core_sha="d9621b9152a92910b8a499a44b412b43fe3bd59c223b774ba54c3fee346d8e7f"
    cef_sha="2ab7cb59ee2e9bce5ae33732a1f46c14d9ecb36a976ce8f89260fa59f8427004"
    ;;
  *)
    echo "Electrobun v${version} has no pinned runtime for ${asset_platform}-${asset_arch}" >&2
    exit 1
    ;;
esac

electrobun_link="setup/node_modules/electrobun"
if [[ ! -d "$electrobun_link" ]]; then
  echo "run bun install before provisioning Electrobun" >&2
  exit 1
fi
electrobun_dir="$(cd "$electrobun_link" && pwd -P)"
dist_dir="$electrobun_dir/dist-${dist_platform}-${asset_arch}"
mkdir -p "$cache_root" "$electrobun_dir/.cache" "$electrobun_dir/bin" "$dist_dir"

verify_sha256() {
  node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const [file, expected] = process.argv.slice(1);
    const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (actual !== expected) throw new Error(`${file}: expected ${expected}, got ${actual}`);
  ' "$1" "$2"
}

fetch_asset() {
  local kind="$1"
  local expected="$2"
  local asset="electrobun-${kind}-${asset_platform}-${asset_arch}.tar.gz"
  local destination="$cache_root/$asset"

  if [[ -f "$destination" ]] && ! verify_sha256 "$destination" "$expected"; then
    rm -f -- "$destination"
  fi
  if [[ ! -f "$destination" ]]; then
    curl --fail --location --retry 4 --retry-all-errors \
      --output "$destination.partial" "$release_base/$asset"
    verify_sha256 "$destination.partial" "$expected"
    mv -- "$destination.partial" "$destination"
  fi
  verify_sha256 "$destination" "$expected"
  printf '%s\n' "$destination"
}

cli_archive="$(fetch_asset cli "$cli_sha")"
core_archive="$(fetch_asset core "$core_sha")"
cef_archive="$(fetch_asset cef "$cef_sha")"

tar -xzf "$cli_archive" -C "$electrobun_dir/.cache"
tar -xzf "$core_archive" -C "$dist_dir"
tar -xzf "$cef_archive" -C "$dist_dir"

binary_suffix=""
if [[ "$asset_platform" == "win" ]]; then
  binary_suffix=".exe"
fi
test -s "$electrobun_dir/.cache/electrobun${binary_suffix}"
test -s "$dist_dir/bun${binary_suffix}"
test -d "$dist_dir/cef"
cp -- "$electrobun_dir/.cache/electrobun${binary_suffix}" \
  "$electrobun_dir/bin/electrobun${binary_suffix}"
if [[ "$asset_platform" != "win" ]]; then
  chmod 0755 "$electrobun_dir/.cache/electrobun" "$electrobun_dir/bin/electrobun"
fi

printf 'Electrobun v%s provisioned for %s-%s from verified release assets.\n' \
  "$version" "$asset_platform" "$asset_arch"
