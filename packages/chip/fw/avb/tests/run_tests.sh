#!/usr/bin/env bash
#
# Host KAT + negative harness for the E1 AVB vbmeta verifier, plus the
# freestanding riscv64 cross-build. Exits non-zero on any failure.
#
# Generates the vbmeta test vectors (make_vbmeta.py, python `cryptography`
# Ed25519), compiles the verifier with host gcc against the shared
# fw/boot-rom/secure crypto, runs every vector, then cross-compiles the
# verifier freestanding for riscv64-unknown-elf.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
avb="$(cd -- "$here/.." && pwd)"

echo "[1/3] host KAT + negative suite"
make -C "$avb" run

echo "[2/3] riscv64 freestanding build"
make -C "$avb" target

echo "[3/3] OK"
