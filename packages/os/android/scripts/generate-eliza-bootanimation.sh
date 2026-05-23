#!/usr/bin/env bash
# Render the elizaOS boot splash for the AOSP fork: the white elizaOS logo
# on the elizaOS blue field, as the PNG frame sequence AOSP's bootanimation
# daemon plays during boot (kernel logo -> this splash -> Eliza launcher).
#
# Frames land under vendor/eliza/bootanimation/{part0,part1}/ and are packed
# into bootanimation.zip by build-bootanimation.mjs (see ../Makefile:
# `make bootanimation`). The rendered frames + zip are gitignored — this
# script regenerates them from the canonical brand SVG on demand, the same
# way packages/os/linux/elizaos renders its branding.
#
# Requires ImageMagick (`convert`), matching the Linux brand-asset generator.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../../.." && pwd)"

LOGO_SVG="${REPO_ROOT}/packages/app/public/brand/logos/logo_white_nobg.svg"
BOOTANIM_DIR="${HERE}/../vendor/eliza/bootanimation"
PART0="${BOOTANIM_DIR}/part0"   # one-shot intro: logo fades in
PART1="${BOOTANIM_DIR}/part1"   # idle loop until boot completes

# Device framebuffer geometry (matches desc.txt); the eliza_cf_*_phone
# products all use the Cuttlefish 1080x2400 panel.
WIDTH=1080
HEIGHT=2400
FPS=30
LOGO_W=480
INTRO_FRAMES=16
BLUE="#0B35F1"   # elizaOS blue, identical to the Linux greeter field.

if ! command -v convert >/dev/null 2>&1; then
    echo "ImageMagick (convert) is required to render the boot splash" >&2
    exit 1
fi
if [ ! -f "${LOGO_SVG}" ]; then
    echo "Missing brand logo: ${LOGO_SVG}" >&2
    exit 1
fi

rm -rf "${PART0}" "${PART1}"
mkdir -p "${PART0}" "${PART1}"

# Intro: composite the logo onto the blue field at increasing opacity.
for i in $(seq 0 $((INTRO_FRAMES - 1))); do
    alpha="$(awk "BEGIN { printf \"%.4f\", ${i} / (${INTRO_FRAMES} - 1) }")"
    convert -size "${WIDTH}x${HEIGHT}" "xc:${BLUE}" \
        \( -background none "${LOGO_SVG}" -resize "${LOGO_W}x" \
           -channel A -evaluate multiply "${alpha}" +channel \) \
        -gravity center -composite \
        "${PART0}/$(printf '%04d' "${i}").png"
done

# Idle loop: the fully-opaque logo, held until the framework starts.
convert -size "${WIDTH}x${HEIGHT}" "xc:${BLUE}" \
    \( -background none "${LOGO_SVG}" -resize "${LOGO_W}x" \) \
    -gravity center -composite \
    "${PART1}/0000.png"

# desc.txt: play the intro once, then loop the idle frame until boot.
cat > "${BOOTANIM_DIR}/desc.txt" <<EOF
${WIDTH} ${HEIGHT} ${FPS}
p 1 0 part0
p 0 0 part1
EOF

echo "Rendered elizaOS boot splash into ${BOOTANIM_DIR} (${INTRO_FRAMES} intro frames + idle loop)"
echo "Pack it with: node packages/scripts/distro-android/build-bootanimation.mjs --frames ${BOOTANIM_DIR} --out ${BOOTANIM_DIR}/bootanimation.zip"
