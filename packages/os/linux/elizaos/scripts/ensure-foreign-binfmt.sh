#!/usr/bin/env bash
set -euo pipefail

arch="${ELIZAOS_ARCH:?ELIZAOS_ARCH is required}"
host_arch="$(dpkg --print-architecture)"

if [ "$arch" = "$host_arch" ]; then
    exit 0
fi

case "$arch" in
    arm64) handler=qemu-aarch64 ;;
    riscv64) handler=qemu-riscv64 ;;
    *)
        echo "ERROR: unsupported foreign architecture: $arch" >&2
        exit 64
        ;;
esac

if [ ! -e /proc/sys/fs/binfmt_misc/register ]; then
    mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc 2>/dev/null || true
fi
if [ ! -e /proc/sys/fs/binfmt_misc/register ]; then
    echo "ERROR: binfmt_misc is unavailable; run the builder with --privileged." >&2
    exit 65
fi

if [ -e "/proc/sys/fs/binfmt_misc/$handler" ]; then
    if grep -q '^enabled' "/proc/sys/fs/binfmt_misc/$handler"; then
        exit 0
    fi
    printf '%s\n' 1 >"/proc/sys/fs/binfmt_misc/$handler" 2>/dev/null || true
fi

if [ ! -e "/proc/sys/fs/binfmt_misc/$handler" ] ||
    ! grep -q '^enabled' "/proc/sys/fs/binfmt_misc/$handler"; then
    config="/usr/lib/binfmt.d/$handler.conf"
    if [ ! -r "$config" ]; then
        config="/usr/share/qemu/binfmt.d/$handler.conf"
    fi
    if [ ! -r "$config" ]; then
        echo "ERROR: no binfmt registration config for $handler." >&2
        exit 65
    fi
    registration="$(sed -n '1p' "$config")"
    if [ -z "$registration" ]; then
        echo "ERROR: empty binfmt registration config for $handler." >&2
        exit 65
    fi
    printf '%s\n' "$registration" >/proc/sys/fs/binfmt_misc/register
fi

if [ ! -e "/proc/sys/fs/binfmt_misc/$handler" ] ||
    ! grep -q '^enabled' "/proc/sys/fs/binfmt_misc/$handler"; then
    echo "ERROR: failed to enable $handler for foreign $arch execution." >&2
    exit 65
fi

echo "enabled $handler for foreign $arch execution"
