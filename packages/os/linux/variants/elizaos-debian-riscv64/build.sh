#!/usr/bin/env bash
# elizaOS Debian RISC-V 64 — live-build orchestrator (skeleton).
#
# Wave 2B-B1 scope: scaffolding only. This script wires up the steps a
# real riscv64 ISO build needs — `lb config`, `lb build`, artifact copy,
# checksum, manifest fill-in — but the rootfs configuration that makes
# `lb build` actually produce a bootable image is Wave 4 work. Wave 4
# stubs below fail closed with `exit 1` rather than silently no-op'ing.
#
# Intended usage (once Wave 4 lands the rootfs config):
#   ./build.sh             full build → out/elizaos-debian-riscv64-<ts>.iso
#
# Container entrypoint when invoked via the Dockerfile.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${ELIZAOS_OUT_DIR:-${HERE}/out}"
ARCH="riscv64"
KERNEL_FLAVOUR="riscv64"
BOOTLOADER="grub-efi"
BUILD_TS="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT_BASENAME="elizaos-debian-riscv64-${BUILD_TS}"

mkdir -p "${OUT}"

echo "=== elizaOS Debian RISC-V 64 build ==="
echo "    arch:        ${ARCH}"
echo "    kernel:      ${KERNEL_FLAVOUR}"
echo "    bootloader:  ${BOOTLOADER}"
echo "    output dir:  ${OUT}"

# ── Step 1: lb config ────────────────────────────────────────────────
# Initialise the live-build config tree with riscv64 defaults. The
# auto/config script in this variant pins the architecture, kernel
# flavour, and bootloader so re-running is idempotent.
echo
echo "--- step 1/4: lb config ---"
if ! command -v lb >/dev/null 2>&1; then
    echo "ERROR: live-build (lb) not found on PATH. Run inside the builder container." >&2
    exit 1
fi

lb config \
    --distribution trixie \
    --architecture "${ARCH}" \
    --linux-flavours "${KERNEL_FLAVOUR}" \
    --bootloaders "${BOOTLOADER}"

# ── Step 2: lb build ─────────────────────────────────────────────────
# STATUS_LATER: Wave 4. We do not yet have the chroot package list,
# kernel/initrd selection, or the elizaOS userland integration needed
# for `lb build` to produce a bootable riscv64 image. Wave 4 lands:
#   - config/package-lists/elizaos.list.chroot
#   - hooks for the elizaOS agent + greeter
#   - U-Boot / grub-efi-riscv64 boot menu
#   - firmware blob sourcing from the chip submodule at runtime
# Until then this step fails closed so callers cannot mistake an
# empty output for a real build.
echo
echo "--- step 2/4: lb build ---"
echo "STATUS_LATER: Wave 4 — rootfs configuration not implemented." >&2
echo "  Once Wave 4 lands the package lists + hooks, replace this gate" >&2
echo "  with: lb build" >&2
exit 1

# ── Step 3: copy artifact + compute sha256/size ──────────────────────
# Wave 4 will produce either binary.hybrid.iso (live-build default) or
# a raw .img if we switch to image-mode. Both go to ${OUT} with a
# stable, dated basename so the release pipeline can pick them up.
echo
echo "--- step 3/4: copy artifact + checksums ---"
ARTIFACT_SRC=""
for candidate in "${HERE}/binary.hybrid.iso" "${HERE}/binary.img" "${HERE}/live-image-${ARCH}.hybrid.iso"; do
    if [ -f "${candidate}" ]; then
        ARTIFACT_SRC="${candidate}"
        break
    fi
done

if [ -z "${ARTIFACT_SRC}" ]; then
    echo "ERROR: no live-build output artifact found (expected binary.hybrid.iso / binary.img / live-image-${ARCH}.hybrid.iso)" >&2
    exit 1
fi

ARTIFACT_EXT="${ARTIFACT_SRC##*.}"
ARTIFACT_DST="${OUT}/${ARTIFACT_BASENAME}.${ARTIFACT_EXT}"
cp "${ARTIFACT_SRC}" "${ARTIFACT_DST}"

ARTIFACT_SHA256="$(sha256sum "${ARTIFACT_DST}" | awk '{ print $1 }')"
ARTIFACT_SIZE="$(stat -c %s "${ARTIFACT_DST}")"
echo "    artifact: ${ARTIFACT_DST}"
echo "    sha256:   ${ARTIFACT_SHA256}"
echo "    size:     ${ARTIFACT_SIZE} bytes"

# ── Step 4: emit manifest fragment ───────────────────────────────────
# Substitute the freshly-computed values into manifest.json.template
# and write the result alongside the artifact. The release pipeline
# (packages/os/release/) merges this fragment into the top-level
# elizaos-os-release-manifest.json under `artifacts[]`.
echo
echo "--- step 4/4: emit manifest fragment ---"
MANIFEST_TEMPLATE="${HERE}/manifest.json.template"
MANIFEST_OUT="${OUT}/${ARTIFACT_BASENAME}.manifest.json"

if [ ! -f "${MANIFEST_TEMPLATE}" ]; then
    echo "ERROR: missing manifest template at ${MANIFEST_TEMPLATE}" >&2
    exit 1
fi

sed \
    -e "s|@@FILENAME@@|${ARTIFACT_BASENAME}.${ARTIFACT_EXT}|g" \
    -e "s|@@SHA256@@|${ARTIFACT_SHA256}|g" \
    -e "s|\"sizeBytes\": 0|\"sizeBytes\": ${ARTIFACT_SIZE}|g" \
    -e "s|@@BUILD_TIMESTAMP@@|${BUILD_TS}|g" \
    "${MANIFEST_TEMPLATE}" > "${MANIFEST_OUT}"

echo "    manifest: ${MANIFEST_OUT}"
echo
echo "=== build complete ==="
