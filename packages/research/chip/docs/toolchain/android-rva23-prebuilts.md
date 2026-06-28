# Android RVA23 prebuilts + AOSP branch pin

## Why we need a pin

Google removed RISC-V from the Android Common Kernel as primary branch in
April 2024, then reinstated RVA23 RISC-V as Tier 1 late 2025. As of
2026-05-19 there is no single AOSP RISC-V branch with stable Tier 1 CTS
that is safe to pin for an open dev-board project.

Pinning the AOSP RISC-V branch SHA is mandatory before any Android boot
claim can be made. Without a SHA, every "Android RISC-V" build is at the
mercy of the floating `master` and reproducibility breaks.

## Required prebuilts

| Surface | Source | Pin target |
| --- | --- | --- |
| AOSP RISC-V system image | AOSP `master` or `android-15.0.0_r*-riscv64` | branch SHA via `compiler/aosp/manifest.xml` |
| NDK RISC-V (RVA23U64) | `android-ndk-rXX-linux.zip` | NDK release tarball + SHA-256 |
| Bionic libc RVA23 | bundled with AOSP | implicit (via AOSP pin) |
| ART RISC-V backend | `art/runtime` in AOSP | implicit (via AOSP pin) |
| `gcc-riscv64-linux-gnu` glibc cross | Ubuntu apt | recorded in `Dockerfile` apt manifest |

## Manifest

[`compiler/aosp/manifest.xml`](../../compiler/aosp/manifest.xml) holds the
pinned manifest commit. The `revision` attribute is
`6dc9af1b583e5c6a4ab9c38e3f5646efd8079b7d`, resolved from
`android-latest-release` on 2026-05-22. The project list is empty by intent:
the manifest pin supports reproducible toolchain-profile work, while Android
boot or CTS claims still require explicit project SHA capture and BSP evidence.

## Status

**BLOCKED for Android boot claims.** Refresh procedure once Google stabilizes
the full AOSP RISC-V project set:

1. Identify the branch (e.g. `android-15.0.0_r4-riscv64`).
2. Run `repo init -u https://android.googlesource.com/platform/manifest -b <branch>`.
3. Capture every project's SHA into `<project sha1=...>` entries in
   `compiler/aosp/manifest.xml`.
4. Pin the NDK release in
   `docs/evidence/compiler/android-rva23-prebuilts.yaml`.
5. Update [`docs/evidence/compiler/aosp-branch-pin.yaml`](../evidence/compiler/aosp-branch-pin.yaml)
   with verification commands and remove the BLOCKED status.

## Evidence gate

[`docs/evidence/compiler/aosp-branch-pin.yaml`](../evidence/compiler/aosp-branch-pin.yaml)
fails closed until a stable branch SHA is committed.

## Cross-references

- LLVM trunk: `docs/toolchain/llvm-trunk-pin.md`.
- IREE backend: `docs/toolchain/iree-eliza-npu.md`.
- Reproducibility: `docs/toolchain/reproducibility.md`.
