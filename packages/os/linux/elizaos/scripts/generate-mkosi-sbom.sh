#!/usr/bin/env bash
# Mounts the exact canonical root partition read-only and generates an SPDX JSON
# inventory from the shipped filesystem. This is deliberately not a source-tree
# SBOM and never mounts a guessed partition.
set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "usage: $0 <expanded.raw> <output.spdx.json> <syft-binary>" >&2
    exit 64
fi

image="$1"
output="$2"
syft_bin="$3"

if [ "$(id -u)" -ne 0 ]; then
    echo "mkosi disk SBOM generation requires root" >&2
    exit 1
fi
if [ ! -f "$image" ] || [ -L "$image" ] || [ ! -s "$image" ]; then
    echo "expanded mkosi image must be a nonempty regular file, not a symlink" >&2
    exit 1
fi
if [ ! -x "$syft_bin" ] || [ -L "$syft_bin" ]; then
    echo "Syft must be an executable regular file, not a symlink" >&2
    exit 1
fi
for command in losetup lsblk mount umount udevadm; do
    command -v "$command" >/dev/null || {
        echo "required image inspection command is missing: $command" >&2
        exit 1
    }
done

mount_dir="$(mktemp -d -t elizaos-sbom.XXXXXXXX)"
loop_device=""
mounted=0
cleanup() {
    status=$?
    if [ "$mounted" -eq 1 ]; then
        umount "$mount_dir" || status=1
    fi
    if [ -n "$loop_device" ]; then
        losetup --detach "$loop_device" || status=1
    fi
    rmdir "$mount_dir" || status=1
    exit "$status"
}
trap cleanup EXIT

loop_device="$(losetup --find --show --read-only --partscan -- "$image")"
udevadm settle
mapfile -t root_partitions < <(
    lsblk --paths --noheadings --raw --output PATH,PARTLABEL "$loop_device" |
        awk '$2 == "elizaos-system" { print $1 }'
)
if [ "${#root_partitions[@]}" -ne 1 ]; then
    echo "expected exactly one elizaos-system partition; found ${#root_partitions[@]}" >&2
    exit 1
fi
root_partition="${root_partitions[0]}"
if [ ! -b "$root_partition" ]; then
    echo "resolved elizaos-system partition is not a block device" >&2
    exit 1
fi

mount --read-only --options noload -- "$root_partition" "$mount_dir"
mounted=1
mkdir -p "$(dirname "$output")"
"$syft_bin" "dir:${mount_dir}" --output "spdx-json=${output}"

node - "$output" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const document = JSON.parse(fs.readFileSync(path, "utf8"));
if (document.spdxVersion !== "SPDX-2.3") {
  throw new Error("Syft output is not SPDX 2.3 JSON");
}
if (!Array.isArray(document.packages) || document.packages.length === 0) {
  throw new Error("SPDX document contains no installed packages");
}
NODE
