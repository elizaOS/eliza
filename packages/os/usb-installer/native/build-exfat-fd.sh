#!/usr/bin/env bash
set -euo pipefail

# Development/qualification builder. Nothing is installed or privileged here.
# Source: exfatprogs 1.2.9, commit 3e87676349387a119cadacd68661d2966796b7fd.
if [[ $# != 2 ]]; then
  echo "usage: $0 <pinned-exfatprogs.tar.gz> <new-output-directory>" >&2
  exit 2
fi
source_archive=$(realpath -- "$1")
output=$(realpath -m -- "$2")
native_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
expected=2c342bb1a4a9fb5ace61020bb6fae1784cb48e98577b18e271691d9de85fa337
actual=$(sha256sum -- "$source_archive")
if [[ ${actual%% *} != "$expected" ]]; then
  echo 'exfatprogs source digest mismatch' >&2
  exit 1
fi
if [[ -e "$output" || -L "$output" ]]; then
  echo 'output directory must not already exist' >&2
  exit 1
fi
build=$(mktemp -d)
trap 'rm -rf -- "$build"' EXIT
tar -xzf "$source_archive" --directory "$build" --strip-components=1 --no-same-owner
patch --batch --fuzz=0 --directory "$build" -p1 < "$native_dir/exfatprogs-fd.patch"
export SOURCE_DATE_EPOCH=1747124226
export LC_ALL=C
export CFLAGS="-O2 -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=3 -ffile-prefix-map=$build=."
export LDFLAGS='-pie -Wl,-z,relro,-z,now'
(
  cd "$build"
  ./autogen.sh
  ./configure
  make -j2 -C lib
  make -j2 -C mkfs
  make -j2 -C fsck
)
mkdir -- "$output"
install -m 0755 "$build/mkfs/mkfs.exfat" "$output/elizaos-mkfs-exfat-fd"
install -m 0755 "$build/fsck/fsck.exfat" "$output/elizaos-fsck-exfat-fd"
install -m 0644 "$build/COPYING" "$output/COPYING.exfatprogs"
(
  cd "$output"
  sha256sum elizaos-mkfs-exfat-fd elizaos-fsck-exfat-fd > SHA256SUMS
)
