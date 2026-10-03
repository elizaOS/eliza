#!/usr/bin/env bash
# Render the checked-in SVG branding for live-build's Plymouth, GDM and GRUB.
set -euo pipefail
if [[ $# != 1 || ! -d "$1/assets" || ! -d "$1/config" ]]; then
    echo "usage: $0 <live-build-variant-directory>" >&2
    exit 64
fi
root="$(cd "$1" && pwd)"
for tool in rsvg-convert convert; do
    command -v "$tool" >/dev/null || { echo "Missing branding renderer: $tool" >&2; exit 69; }
done
for asset in logo_white_nobg logo_blue_nobg elizaOS_text_white; do
    [[ -s "$root/assets/$asset.svg" ]] || { echo "Missing branding asset: $asset.svg" >&2; exit 66; }
done
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
rsvg-convert -w 256 -o "$scratch/logo.png" "$root/assets/logo_white_nobg.svg"
rsvg-convert -w 320 -o "$scratch/wordmark.png" "$root/assets/elizaOS_text_white.svg"
convert -size 8x8 xc:none -fill white -draw 'circle 3.5,3.5 3.5,0' -define png:exclude-chunks=date,time "$scratch/dot.png"
convert -size 1920x1080 'xc:#0B35F1' "$scratch/logo.png" -gravity center -composite -depth 8 -define png:exclude-chunks=date,time "PNG24:$scratch/background.png"
for size in 16 24 32 48 64 128 256 512; do
    rsvg-convert -w "$size" -h "$size" -o "$scratch/icon-$size.png" "$root/assets/logo_blue_nobg.svg"
done
# Finish rendering before replacing any existing build inputs.
share="$root/config/includes.chroot/usr/share"
for asset in logo wordmark dot; do
    install -D -m 0644 "$scratch/$asset.png" "$share/plymouth/themes/elizaos/$asset.png"
done
for name in desktop login; do
    install -D -m 0644 "$scratch/background.png" "$share/backgrounds/elizaos/$name.png"
done
install -D -m 0644 "$scratch/background.png" "$root/config/includes.binary/boot/grub/elizaos-splash.png"
for size in 16 24 32 48 64 128 256 512; do
    install -D -m 0644 "$scratch/icon-$size.png" "$share/icons/hicolor/${size}x${size}/apps/elizaos.png"
done
