#!/usr/bin/env bash
# Regenerate elizaOS raster branding from the canonical SVG sources.
#
# Outputs:
#   config/includes.chroot/usr/share/backgrounds/elizaos/desktop.png   (1920x1080)
#   config/includes.chroot/usr/share/backgrounds/elizaos/login.png     (1920x1080)
#   config/includes.chroot/boot/grub/splash.png                        (1024x768)
#   config/includes.chroot/usr/share/plymouth/themes/elizaos/logo.png
#   config/includes.chroot/usr/share/plymouth/themes/elizaos/wordmark.png
#   config/includes.chroot/usr/share/plymouth/themes/elizaos/dot.png
#   config/includes.chroot/usr/share/icons/hicolor/<size>/apps/elizaos.png
#
# Palette is locked: elizaOS blue #0B35F1 + white. ImageMagick required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="${ROOT}/assets"
CHROOT="${ROOT}/config/includes.chroot"

WORDMARK_WHITE_SVG="${ASSETS}/elizaos_logotext.svg"
WORDMARK_BLUE_SVG="${ASSETS}/elizaos_logotext_black.svg"
ICON_BLUEBG_SVG="${ASSETS}/logo_white_bluebg.svg"
ICON_NOBG_SVG="${ASSETS}/logo_blue_nobg.svg"

BLUE="#0B35F1"
WHITE="#FFFFFF"

if ! command -v convert >/dev/null 2>&1; then
    echo "ERROR: ImageMagick 'convert' is required." >&2
    exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# Recolor wordmark from canonical "black" SVG to elizaOS blue.
BLUE_WORDMARK_SVG="${TMP}/wordmark_blue.svg"
perl -0pe 's/fill="black"/fill="#0B35F1"/g; s/fill="#000000"/fill="#0B35F1"/g' \
    "${WORDMARK_BLUE_SVG}" > "${BLUE_WORDMARK_SVG}"

render_svg() {
    convert -background none "$1" -resize "${2}x" -trim +repage "$3"
}

mkdir -p \
    "${CHROOT}/usr/share/backgrounds/elizaos" \
    "${CHROOT}/boot/grub" \
    "${CHROOT}/usr/share/plymouth/themes/elizaos"

# Desktop + login wallpaper: solid elizaOS blue with centered white wordmark.
render_svg "${WORDMARK_WHITE_SVG}" 720 "${TMP}/wordmark-desktop.png"
convert -size 1920x1080 "xc:${BLUE}" \
    -fill "rgba(255,255,255,0.08)" -draw "circle 1620,180 2150,710" \
    -fill "rgba(255,255,255,0.05)" -draw "circle 300,950 -200,650" \
    "${TMP}/wordmark-desktop.png" -gravity center -composite \
    "${CHROOT}/usr/share/backgrounds/elizaos/desktop.png"

cp "${CHROOT}/usr/share/backgrounds/elizaos/desktop.png" \
   "${CHROOT}/usr/share/backgrounds/elizaos/login.png"

# GRUB splash: 1024x768 elizaOS blue with white wordmark.
render_svg "${WORDMARK_WHITE_SVG}" 500 "${TMP}/wordmark-grub.png"
convert -size 1024x768 "xc:${BLUE}" \
    -fill "rgba(255,255,255,0.10)" -draw "circle 850,120 1120,390" \
    "${TMP}/wordmark-grub.png" -gravity center -geometry +0-30 -composite \
    "${CHROOT}/boot/grub/splash.png"

# Plymouth logo (the elizaOS icon — white-on-blue, 256x256 transparent).
convert -background none "${ICON_BLUEBG_SVG}" -resize 256x256 \
    "${CHROOT}/usr/share/plymouth/themes/elizaos/logo.png"

# Plymouth wordmark (white wordmark, transparent bg).
render_svg "${WORDMARK_WHITE_SVG}" 480 \
    "${CHROOT}/usr/share/plymouth/themes/elizaos/wordmark.png"

# Plymouth progress dot.
convert -size 12x12 xc:none -fill "${WHITE}" -draw "circle 6,6 6,1" \
    "${CHROOT}/usr/share/plymouth/themes/elizaos/dot.png"

# Hicolor icon set for the application launcher / GDM logo.
for size in 16 32 48 64 128 256 512; do
    OUT_DIR="${CHROOT}/usr/share/icons/hicolor/${size}x${size}/apps"
    mkdir -p "${OUT_DIR}"
    convert -background none "${ICON_NOBG_SVG}" -resize "${size}x${size}" \
        "${OUT_DIR}/elizaos.png"
done

echo "OK: brand assets regenerated under ${CHROOT}"
