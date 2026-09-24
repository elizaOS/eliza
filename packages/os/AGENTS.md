# elizaOS OS repository guide

This repository is the release boundary for elizaOS operating-system images,
installers, and their CI/CD. Framework, web application, Android/iOS app hosts,
native runtimes, and native plugins belong in `elizaOS/eliza`; consume their
published packages and artifacts rather than copying source here.

## Toolchain

- Bun 1.3.14 on Node 24, ESM only.
- Turbo orchestrates workspace build, typecheck, lint, and tests.
- Biome formats and lints TypeScript and JSON.
- AOSP, Debian/live-build, Gradle, Xcode, CMake, Docker, QEMU, and hardware
  toolchains are required only for their corresponding platform lanes.

Run `bun install`, then `bun run verify` before declaring a source-only change
ready. Image and native changes must also run the relevant platform workflow or
hardware test; a TypeScript check is not proof that an image boots or a native
bridge works.

## Layout and ownership

- `android/`: AOSP products, vendor policy, system UI, and image integration.
- `linux/`: Debian-based live images, VM images, and confidential-compute policy.
- `linux/packaging/debian/`: Debian application packaging.
- `setup/`, `usb-installer/`: OS distribution surfaces.
- `scripts/`: release contracts and validation.

Read a package's nearest `AGENTS.md` and `README.md` before editing it.
`AGENTS.md` is canonical; do not create duplicate instruction files.

## Engineering rules

- Write **elizaOS**, npm scope `@elizaos/*`, and **Eliza agents**.
- Use structured logging in runtime/server code; do not add `console` calls.
- Fail fast internally and translate errors only at explicit boundaries. Never
  fabricate empty or zero results for failed native, image, or release paths.
- Keep image manifests, digests, signing inputs, update metadata, and measured
  boot policy fail-closed. Generated artifacts must be reproducible.
- Never commit build caches, SDKs, toolchains, model weights, signing material,
  device credentials, or local evidence.
- Application artifacts and package versions are cross-repository contracts.
  OS image builds must pin and verify the inputs they consume from `elizaOS/eliza`.

## Verification and releases

Every platform change needs evidence from the real boundary it affects:
booted AOSP/Cuttlefish or device output, a built and installed Debian/live
image, RISC-V build output on the target architecture, or signed release
manifest verification. Include failure-path evidence and inspect the produced
artifacts manually. CI and release workflows under `.github/workflows/` are
owned here; do not recreate OS release jobs in `elizaOS/eliza`.

Open changes against `develop`, sync with the target branch before final
verification, and use a PR. Never publish packages or images from an unverified
working tree.
