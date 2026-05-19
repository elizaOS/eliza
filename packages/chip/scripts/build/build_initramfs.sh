#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Build a minimal busybox initramfs (cpio.gz) for Eliza Tier 2 Linux boot.
#
# Inputs:
#   $1 (optional): path to static busybox binary.
#                  Default: external/busybox/busybox
#
# Output:
#   build/initramfs/eliza_tier2.cpio.gz
#
# Expected size: ~1 MB.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUSYBOX="${1:-${REPO_ROOT}/external/busybox/busybox}"
OUT_DIR="${REPO_ROOT}/build/initramfs"
ROOT_DIR="${OUT_DIR}/root"
OUT_CPIO="${OUT_DIR}/eliza_tier2.cpio.gz"

if [[ ! -x "${BUSYBOX}" ]]; then
  echo "ERROR: busybox not found or not executable at ${BUSYBOX}" >&2
  echo "Build it first with:" >&2
  echo "  cd external/busybox && make defconfig" >&2
  echo "  make LDFLAGS=--static CROSS_COMPILE=riscv64-linux-gnu- -j\$(nproc)" >&2
  exit 1
fi

rm -rf "${ROOT_DIR}"
mkdir -p "${ROOT_DIR}"/{bin,sbin,etc,proc,sys,dev,tmp,root,usr/bin,usr/sbin}

install -m 0755 "${BUSYBOX}" "${ROOT_DIR}/bin/busybox"
ln -sf busybox "${ROOT_DIR}/bin/sh"

cat > "${ROOT_DIR}/init" <<'INIT'
#!/bin/sh
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
echo "eliza tier2: linux booted"
exec /bin/sh
INIT
chmod +x "${ROOT_DIR}/init"

if command -v mknod >/dev/null 2>&1; then
  if [[ "$(id -u)" -eq 0 ]] || command -v fakeroot >/dev/null 2>&1; then
    MKNOD=(mknod)
    if [[ "$(id -u)" -ne 0 ]]; then MKNOD=(fakeroot mknod); fi
    rm -f "${ROOT_DIR}/dev/console" "${ROOT_DIR}/dev/null"
    "${MKNOD[@]}" "${ROOT_DIR}/dev/console" c 5 1
    "${MKNOD[@]}" "${ROOT_DIR}/dev/null"    c 1 3
  else
    echo "WARN: not root and no fakeroot; relying on devtmpfs at boot." >&2
  fi
fi

cd "${ROOT_DIR}"
if command -v fakeroot >/dev/null 2>&1 && [[ "$(id -u)" -ne 0 ]]; then
  fakeroot -- sh -c "find . -print0 | cpio --null -ov --format=newc | gzip -9" > "${OUT_CPIO}"
else
  find . -print0 | cpio --null -ov --format=newc 2>/dev/null | gzip -9 > "${OUT_CPIO}"
fi

echo "wrote: ${OUT_CPIO}"
ls -lh "${OUT_CPIO}"
