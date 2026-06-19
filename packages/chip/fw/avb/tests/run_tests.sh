#!/usr/bin/env bash
#
# Host KAT + negative harness for the E1 AVB vbmeta verifier AND the A/B slot +
# OTA apply + recovery state machine, plus the freestanding riscv64 cross-build.
# Exits non-zero on any failure.
#
# Generates the vbmeta + A/B/OTA test vectors (make_vbmeta.py / make_ab_images.py,
# python `cryptography` Ed25519), compiles the verifier and the A/B/OTA logic
# with host gcc against the shared fw/boot-rom/secure crypto, runs every vector,
# then cross-compiles all four translation units freestanding for
# riscv64-unknown-elf.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
avb="$(cd -- "$here/.." && pwd)"

echo "[1/4] host vbmeta KAT + negative suite"
make -C "$avb" run

echo "[2/4] host A/B slot + OTA apply + recovery suite"
make -C "$avb" run-abota

echo "[3/4] riscv64 freestanding build (verifier + A/B + OTA)"
make -C "$avb" target

echo "[4/4] OK"
