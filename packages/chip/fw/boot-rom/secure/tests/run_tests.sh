#!/usr/bin/env bash
#
# Host KAT harness for the E1 secure-boot crypto + OPNPHN01 verifier.
# Compiles with host gcc (NOT the RISC-V cross compiler), generates the test
# images, and runs every vector. Exits non-zero on any failure.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
secure="$(cd -- "$here/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

CC="${CC:-gcc}"
CFLAGS=(
    -std=c11
    -O2
    -Wall
    -Wextra
    -Wno-unused-parameter
    -Werror
    "-I$secure"
    "-I$work"
)

echo "[1/3] generating OPNPHN01 test images"
python3 "$here/make_images.py" "$work"

echo "[2/3] compiling KAT harness with $CC"
"$CC" "${CFLAGS[@]}" \
    "$here/test_kat.c" \
    "$secure/sha256.c" \
    "$secure/ed25519_ct.c" \
    "$secure/verify.c" \
    "$secure/measure.c" \
    -o "$work/test_kat"

echo "[3/3] running KAT"
"$work/test_kat" "$work"
