#!/usr/bin/env bash
# Regenerate elizaOS raster branding from the canonical elizaOS logo.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FONT_DIR="${ROOT}/tails/config/chroot_local-includes/usr/share/fonts/truetype/elizaos"
REGULAR_FONT="${FONT_DIR}/Poppins-Regular.ttf"
MEDIUM_FONT="${FONT_DIR}/Poppins-Medium.ttf"
WORDMARK_WHITE_SVG="${ROOT}/assets/elizaos_logotext.svg"
WORDMARK_BLUE_SVG="${ROOT}/assets/elizaos_logotext_black.svg"
ICON_BLUEBG_SVG="${ROOT}/assets/logo_white_bluebg.svg"

BLUE="#0B35F1"
WHITE="#FFFFFF"
ICE="#F7F9FF"
MIST="#DCE5FF"
LINE="#C9D6FF"

if ! command -v convert >/dev/null 2>&1; then
    echo "ImageMagick convert is required" >&2
    exit 1
fi

for font in "${REGULAR_FONT}" "${MEDIUM_FONT}"; do
    if [ ! -f "${font}" ]; then
        echo "Missing font: ${font}" >&2
        exit 1
    fi
done

for asset in "${WORDMARK_WHITE_SVG}" "${WORDMARK_BLUE_SVG}" "${ICON_BLUEBG_SVG}"; do
    if [ ! -f "${asset}" ]; then
        echo "Missing logo asset: ${asset}" >&2
        exit 1
    fi
done

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

BLUE_WORDMARK_SVG="${TMP}/elizaos_logotext_blue.svg"
perl -0pe 's/fill="black"/fill="#0B35F1"/g; s/fill="#000000"/fill="#0B35F1"/g' \
    "${WORDMARK_BLUE_SVG}" >"${BLUE_WORDMARK_SVG}"

render_svg() {
    local source="$1"
    local width="$2"
    local output="$3"

    convert -background none "${source}" -resize "${width}x" \
        -trim +repage "${output}"
}

render_svg "${BLUE_WORDMARK_SVG}" 760 "${TMP}/wordmark-wallpaper.png"
convert -size 1920x1080 "xc:${ICE}" \
    -fill "rgba(255,255,255,0.90)" -draw "rectangle 0,0 1920,1080" \
    -fill "rgba(11,53,241,0.070)" -draw "circle 1650,160 2140,650" \
    -fill "rgba(11,53,241,0.045)" -draw "polygon -180,830 2100,690 2100,760 -180,920" \
    -fill "rgba(201,214,255,0.42)" -draw "polygon -180,965 2100,830 2100,1080 -180,1080" \
    "${TMP}/wordmark-wallpaper.png" -gravity center -geometry +0-52 -composite \
    "${ROOT}/tails/config/chroot_local-includes/usr/share/tails/desktop_wallpaper.png"

render_svg "${BLUE_WORDMARK_SVG}" 680 "${TMP}/wordmark-screensaver.png"
convert -size 1920x1080 "xc:${ICE}" \
    -fill "rgba(255,255,255,0.86)" -draw "rectangle 0,0 1920,1080" \
    -fill "rgba(11,53,241,0.075)" -draw "circle 1500,260 1980,740" \
    -fill "rgba(201,214,255,0.36)" -draw "polygon -180,930 2100,760 2100,1080 -180,1080" \
    "${TMP}/wordmark-screensaver.png" -gravity center -geometry +0-20 -composite \
    "${ROOT}/tails/config/chroot_local-includes/usr/share/tails/screensaver_background.png"

render_svg "${WORDMARK_WHITE_SVG}" 500 "${TMP}/wordmark-grub.png"
convert -size 1024x768 "xc:${BLUE}" \
    -fill "rgba(255,255,255,0.14)" -draw "circle 850,120 1120,390" \
    -fill "rgba(247,249,255,0.16)" -draw "polygon -100,610 1124,488 1124,552 -100,680" \
    -fill "rgba(220,229,255,0.10)" -draw "polygon -100,700 1124,590 1124,768 -100,768" \
    "${TMP}/wordmark-grub.png" -gravity center -geometry +0-30 -composite \
    "${ROOT}/tails/config/binary_local-includes/EFI/debian/grub/splash.png"

render_svg "${BLUE_WORDMARK_SVG}" 320 "${TMP}/wordmark-about.png"
convert -size 400x200 "xc:${WHITE}" \
    -fill "rgba(11,53,241,0.060)" -draw "circle 332,20 456,144" \
    -fill "rgba(201,214,255,0.34)" -draw "polygon -40,154 440,104 440,132 -40,184" \
    "${TMP}/wordmark-about.png" -gravity center -geometry +0-8 -composite \
    "${ROOT}/tails/config/chroot_local-includes/usr/share/tails/elizaos-about-logo.png"

render_svg "${WORDMARK_WHITE_SVG}" 300 "${TMP}/wordmark-plymouth.png"
convert -size 600x400 "xc:${BLUE}" \
    -fill "rgba(255,255,255,0.13)" -draw "circle 500,45 700,245" \
    -fill "rgba(247,249,255,0.15)" -draw "polygon -70,304 670,228 670,264 -70,342" \
    "${TMP}/wordmark-plymouth.png" -gravity center -geometry +0-6 -composite \
    "${ROOT}/tails/config/chroot_local-includes/usr/share/plymouth/themes/elizaos/elizaos-wordmark.png"

convert -background none "${ICON_BLUEBG_SVG}" -resize 112x112 \
    -background none -gravity center -extent 128x128 \
    "${ROOT}/tails/config/chroot_local-includes/usr/share/tails/greeter/icons/elizaos-logo.png"

render_svg "${BLUE_WORDMARK_SVG}" 214 "${TMP}/wordmark-header.png"
convert -size 269x45 "xc:${WHITE}" \
    -fill "rgba(11,53,241,0.055)" -draw "polygon -20,34 289,22 289,45 -20,45" \
    "${TMP}/wordmark-header.png" -gravity center -geometry +0+1 -composite \
    "${ROOT}/tails/config/chroot_local-includes/usr/share/tails-installer/tails-liveusb-header.png"
