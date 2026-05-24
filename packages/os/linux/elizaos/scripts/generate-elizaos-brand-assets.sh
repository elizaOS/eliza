#!/usr/bin/env bash
# Regenerate elizaOS raster branding from the SVG sources in assets/.
# Outputs land under config/includes.chroot (and config/includes.binary
# for the GRUB splash) where the branding hook and Plymouth theme read
# them. Requires ImageMagick (convert).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORDMARK_WHITE_SVG="${ROOT}/assets/eliza_text_white.svg"
LOGO_BLUEBG_SVG="${ROOT}/assets/logo_white_bluebg.svg"
LOGO_NOBG_SVG="${ROOT}/assets/logo_white_nobg.svg"

BLUE="#0B35F1"

CHROOT="${ROOT}/config/includes.chroot"
BINARY="${ROOT}/config/includes.binary"

if ! command -v convert >/dev/null 2>&1; then
    echo "ImageMagick convert is required" >&2
    exit 1
fi

for asset in "${WORDMARK_WHITE_SVG}" "${LOGO_BLUEBG_SVG}" "${LOGO_NOBG_SVG}"; do
    if [ ! -f "${asset}" ]; then
        echo "Missing logo asset: ${asset}" >&2
        exit 1
    fi
done

# Optional brand font: only used if present in the tree.
FONT_OPT=()
BRAND_FONT="${ROOT}/assets/fonts/Poppins-Medium.ttf"
if [ -f "${BRAND_FONT}" ]; then
    FONT_OPT=(-font "${BRAND_FONT}")
fi

emit() {
    # emit <output-path>; ensures the parent dir exists.
    mkdir -p "$(dirname "$1")"
}

# Desktop wallpaper — solid blue field with centered logo + wordmark.
DESKTOP="${CHROOT}/usr/share/backgrounds/elizaos/desktop.png"
emit "${DESKTOP}"
convert -size 1920x1080 "xc:${BLUE}" \
    \( -background none "${LOGO_NOBG_SVG}" -resize 360x \) \
    -gravity center -geometry +0-120 -composite \
    \( -background none "${WORDMARK_WHITE_SVG}" -resize 640x \) \
    -gravity center -geometry +0+220 -composite \
    "${DESKTOP}"

# Login/greeter background — same field, no wordmark.
LOGIN="${CHROOT}/usr/share/backgrounds/elizaos/login.png"
emit "${LOGIN}"
convert -size 1920x1080 "xc:${BLUE}" \
    \( -background none "${LOGO_NOBG_SVG}" -resize 320x \) \
    -gravity center -geometry +0+0 -composite \
    "${LOGIN}"

# App / login-screen logo icon (256x256).
ICON="${CHROOT}/usr/share/icons/hicolor/256x256/apps/elizaos.png"
emit "${ICON}"
convert -background none "${LOGO_BLUEBG_SVG}" -resize 256x256 \
    -background none -gravity center -extent 256x256 \
    "${ICON}"

# Plymouth boot logo (~256px).
PLY_LOGO="${CHROOT}/usr/share/plymouth/themes/elizaos/logo.png"
emit "${PLY_LOGO}"
convert -background none "${LOGO_NOBG_SVG}" -resize 256x \
    -trim +repage "${PLY_LOGO}"

# Plymouth boot wordmark.
PLY_WORDMARK="${CHROOT}/usr/share/plymouth/themes/elizaos/wordmark.png"
emit "${PLY_WORDMARK}"
convert -background none "${WORDMARK_WHITE_SVG}" -resize 400x \
    -trim +repage "${PLY_WORDMARK}"

# Plymouth progress dot (16x16 solid blue circle).
PLY_DOT="${CHROOT}/usr/share/plymouth/themes/elizaos/dot.png"
emit "${PLY_DOT}"
convert -size 16x16 xc:none -fill "${BLUE}" -draw 'circle 8,8 8,2' "${PLY_DOT}"

# GRUB splash — staged in config/includes.binary (boot-stage includes).
# The live live-build GRUB theme (binary/boot/grub/live-theme/theme.txt)
# reads "../splash.png" and theme.cfg gates on /boot/grub/splash.png, so the
# branded splash must land at boot/grub/splash.png to actually display. We
# stage it under BOTH the branded name (for traceability) and splash.png (the
# path GRUB consumes); config/includes.binary overlays last onto binary/, so
# the branded splash deterministically replaces the generic Debian splash.
GRUB_SPLASH="${BINARY}/boot/grub/elizaos-splash.png"
emit "${GRUB_SPLASH}"
convert -size 1920x1080 "xc:${BLUE}" \
    \( -background none "${WORDMARK_WHITE_SVG}" -resize 560x \) \
    -gravity center -geometry +0+0 -composite \
    "${GRUB_SPLASH}"

GRUB_SPLASH_LIVE="${BINARY}/boot/grub/splash.png"
emit "${GRUB_SPLASH_LIVE}"
cp -f "${GRUB_SPLASH}" "${GRUB_SPLASH_LIVE}"

echo "brand assets generated under ${CHROOT} and ${BINARY}"
