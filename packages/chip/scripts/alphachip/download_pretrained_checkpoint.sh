#!/usr/bin/env sh
set -eu

OUT_DIR="${1:-${ALPHACHIP_PRETRAINED_DIR:-/tmp/e1-alphachip/tpu_checkpoint_20240815}}"
URL="${ALPHACHIP_PRETRAINED_URL:-https://storage.googleapis.com/rl-infra-public/circuit-training/tpu_checkpoint_20240815.tar.gz}"
ARCHIVE="${OUT_DIR}.tar.gz"

mkdir -p "$(dirname "$OUT_DIR")"
rm -f "$ARCHIVE"

if ! curl -L --fail "$URL" -o "$ARCHIVE"; then
    cat >&2 <<EOF
Unable to download AlphaChip pretrained checkpoint from:
  $URL

The upstream README documents this checkpoint, but the object may require a
new URL or access policy. Set ALPHACHIP_PRETRAINED_URL to an available mirror,
or unpack the checkpoint manually and pass ALPHACHIP_POLICY_DIR=<checkpoint_dir>
to the training wrappers.
EOF
    exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
tar -xzf "$ARCHIVE" -C "$OUT_DIR" --strip-components=1
echo "$OUT_DIR"
