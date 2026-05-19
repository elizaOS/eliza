#!/usr/bin/env bash
# Build kernel Image + static busybox + initramfs inside a Linux container.
# Outputs land on the host under build/sim/tier2/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

IMG=eliza-tier2-builder
docker build -t "$IMG" - <<'DOCKERFILE'
FROM debian:bookworm-slim
RUN apt-get update -qq && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
        gcc-riscv64-linux-gnu make git curl bc flex bison libssl-dev \
        libelf-dev cpio xz-utils python3 ca-certificates \
        gcc g++ libc6-dev pkg-config && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /work
DOCKERFILE

docker run --rm --platform linux/amd64 -v "$ROOT":/work -w /work "$IMG" bash -c '
set -euxo pipefail

# 1) Kernel
if [ ! -d external/linux ]; then
  git clone --depth 1 --branch v6.6 https://github.com/torvalds/linux external/linux
fi
cd external/linux
make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- defconfig
# merge tiny fragment if present
if [ -f /work/sw/linux/configs/eliza_tier2_qemu_defconfig ]; then
  ./scripts/kconfig/merge_config.sh -m .config /work/sw/linux/configs/eliza_tier2_qemu_defconfig || true
  make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- olddefconfig
fi
make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- -j$(nproc) Image 2>&1 | tail -30
cd /work
mkdir -p build/sim/tier2
cp external/linux/arch/riscv/boot/Image build/sim/tier2/Image
ls -la build/sim/tier2/Image

# 2) Busybox
if [ ! -d external/busybox ]; then
  git clone --depth 1 --branch 1_36_stable https://git.busybox.net/busybox external/busybox || \
  git clone --depth 1 --branch 1_36_0 https://github.com/mirror/busybox external/busybox
fi
cd external/busybox
make defconfig
sed -i "s|.*CONFIG_STATIC.*|CONFIG_STATIC=y|" .config
make oldconfig </dev/null >/dev/null
make CROSS_COMPILE=riscv64-linux-gnu- -j$(nproc) busybox 2>&1 | tail -10
cd /work
cp external/busybox/busybox build/sim/tier2/busybox
file build/sim/tier2/busybox

# 3) Initramfs
INITRAMFS_DIR=build/sim/tier2/rootfs
rm -rf "$INITRAMFS_DIR"
mkdir -p "$INITRAMFS_DIR"/{bin,dev,proc,sys,tmp}
cp build/sim/tier2/busybox "$INITRAMFS_DIR/bin/busybox"
for cmd in sh ls cat echo mount umount mknod ash; do
  ln -sf busybox "$INITRAMFS_DIR/bin/$cmd"
done
mknod "$INITRAMFS_DIR/dev/console" c 5 1 || true
mknod "$INITRAMFS_DIR/dev/null" c 1 3 || true
cat > "$INITRAMFS_DIR/init" <<INIT
#!/bin/sh
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t devtmpfs devtmpfs /dev 2>/dev/null
/bin/busybox echo "eliza tier2: linux booted"
exec /bin/busybox sh
INIT
chmod +x "$INITRAMFS_DIR/init"
(cd "$INITRAMFS_DIR" && find . | cpio -o -H newc 2>/dev/null | gzip -9) > build/sim/tier2/initramfs.cpio.gz
ls -la build/sim/tier2/initramfs.cpio.gz
echo "DONE: artifacts in build/sim/tier2/"
'
