#!/usr/bin/env bash
# elizaOS Linux — unified multi-arch ISO build orchestrator.
#
# Runs end-to-end inside the builder container baked by ./Dockerfile.
# Steps:
#   1. lb config   — apply auto/config (arch-parameterized) to the tree.
#   2. lb build    — produce binary.hybrid.iso.
#   3. verify      — fail closed on missing/undersized/unparseable ISO.
#   4. checksum    — sha256 + size, written next to the artifact.
#   5. manifest    — substitute build evidence into
#                    manifest.json.template → out/<name>.manifest.json.
#
# Invocation:
#   docker build -t elizaos-linux-builder --build-arg ELIZAOS_ARCH=amd64 .
#   docker run --rm --privileged \
#       -e ELIZAOS_ARCH=amd64 \
#       -v "$(pwd):/build" -v "$(pwd)/out:/out" \
#       elizaos-linux-builder
#
# Tunables:
#   ELIZAOS_ARCH            amd64 | arm64 | riscv64 (default: amd64)
#   ELIZAOS_PROFILE         default | secure
#   ELIZAOS_OUT_DIR         override host-side output dir
#   ELIZAOS_MIN_ISO_BYTES   override 200 MiB minimum
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERE="${ELIZAOS_VARIANT_DIR:-${SCRIPT_DIR}}"
OUT="${ELIZAOS_OUT_DIR:-${HERE}/out}"

ARCH="${ELIZAOS_ARCH:-amd64}"
PROFILE="${ELIZAOS_PROFILE:-default}"
BUILD_TS="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT_BASENAME="elizaos-linux-${ARCH}-${PROFILE}-${BUILD_TS}"
MIN_ISO_BYTES="${ELIZAOS_MIN_ISO_BYTES:-209715200}"

mkdir -p "${OUT}"

echo "=== elizaOS Linux build ==="
echo "    arch:        ${ARCH}"
echo "    profile:     ${PROFILE}"
echo "    output dir:  ${OUT}"
echo "    build ts:    ${BUILD_TS}"

# ── Step 1: lb config ────────────────────────────────────────────────
echo
echo "--- step 1/5: lb config ---"
if ! command -v lb >/dev/null 2>&1; then
    echo "ERROR: live-build (lb) not found on PATH. Run inside the builder container." >&2
    exit 1
fi

ELIZAOS_ARCH="${ARCH}" "${HERE}/auto/config"

# Compose the secure hardening overlay on top of the default config.
if [ "${PROFILE}" = "secure" ]; then
    if [ -d "${HERE}/config/profiles/secure" ]; then
        echo "    overlaying secure profile..."
        cp -a "${HERE}/config/profiles/secure/." "${HERE}/config/"
    fi
fi

# Generate raster branding from SVG sources into config/includes.chroot.
# Skipped when ImageMagick is unavailable (branding then falls back to
# whatever PNGs are already staged in the tree).
if command -v convert >/dev/null 2>&1; then
    echo "    generating brand assets..."
    "${HERE}/scripts/generate-elizaos-brand-assets.sh"
else
    echo "    convert (ImageMagick) not found — skipping brand-asset generation." >&2
fi

# ── Step 2: lb build ─────────────────────────────────────────────────
echo
echo "--- step 2/5: lb build (this takes 30+ minutes) ---"
lb build

# ── Step 3: verify ───────────────────────────────────────────────────
echo
echo "--- step 3/5: verify ---"
SRC_ISO="${HERE}/binary.hybrid.iso"
if [ ! -f "${SRC_ISO}" ]; then
    echo "ERROR: expected ${SRC_ISO} not found." >&2
    exit 2
fi

ISO_BYTES="$(stat -c%s "${SRC_ISO}")"
if [ "${ISO_BYTES}" -lt "${MIN_ISO_BYTES}" ]; then
    echo "ERROR: ISO size ${ISO_BYTES} below minimum ${MIN_ISO_BYTES} bytes." >&2
    exit 3
fi

if command -v isoinfo >/dev/null 2>&1; then
    isoinfo -i "${SRC_ISO}" -d >/dev/null
fi

DST_ISO="${OUT}/${ARTIFACT_BASENAME}.iso"
mv "${SRC_ISO}" "${DST_ISO}"
echo "    artifact: ${DST_ISO}"

# ── Step 4: checksum ─────────────────────────────────────────────────
echo
echo "--- step 4/5: checksum ---"
( cd "${OUT}" && sha256sum "$(basename "${DST_ISO}")" > "${ARTIFACT_BASENAME}.iso.sha256" )
echo "    sha256: $(cat "${OUT}/${ARTIFACT_BASENAME}.iso.sha256")"

# ── Step 5: manifest ─────────────────────────────────────────────────
echo
echo "--- step 5/5: manifest ---"
TEMPLATE="${HERE}/manifest.json.template"
if [ ! -f "${TEMPLATE}" ]; then
    echo "WARN: ${TEMPLATE} missing — skipping manifest emission." >&2
else
    SHA256="$(awk '{print $1}' "${OUT}/${ARTIFACT_BASENAME}.iso.sha256")"
    sed \
        -e "s|@ARCH@|${ARCH}|g" \
        -e "s|@PROFILE@|${PROFILE}|g" \
        -e "s|@ARTIFACT@|${ARTIFACT_BASENAME}.iso|g" \
        -e "s|@BUILD_TS@|${BUILD_TS}|g" \
        -e "s|@SHA256@|${SHA256}|g" \
        -e "s|@SIZE@|${ISO_BYTES}|g" \
        "${TEMPLATE}" > "${OUT}/${ARTIFACT_BASENAME}.manifest.json"
    python3 -c "import json,sys; json.load(open('${OUT}/${ARTIFACT_BASENAME}.manifest.json'))"
    echo "    manifest: ${OUT}/${ARTIFACT_BASENAME}.manifest.json"
fi

echo
echo "=== done ==="
