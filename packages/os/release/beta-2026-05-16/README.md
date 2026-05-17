# beta-2026-05-16 — Release Manifests

This directory holds the **pre-release manifest** for the first public ElizaOS beta. It is checked in with `sha256: null` and `sizeBytes: null` on every artifact, by design.

## State: awaiting first real release

All five artifacts in `manifest.json` are in `status: candidate` with `sha256: null`. The Android per-partition manifest (`android-release-manifest.json`) uses all-zero sha256 placeholders and `sizeBytes: 1` for the same reason.

This is **not** a broken state. The pipeline gates publication on real values:

- `scripts/validate-release-manifest.mjs --require-publishable-checksums` fails on `null` AND on the all-zero placeholder. It is run by the `populate-and-validate-manifest` job in `.github/workflows/elizaos-os-full-release.yml` after artifacts are downloaded.
- `android/installer/scripts/validate-release-manifest.mjs` rejects the all-zero hash and the `sizeBytes: 1` sentinel — it cannot be tricked into passing the placeholder values that ship in this file.
- `release.status` is only promoted to `available` after the strict gate passes.

See `packages/os/RELEASE.md` for the full runbook.

## Known gap: missing build workflows

The manifest declares five artifact filenames:

| id | filename |
| --- | --- |
| `raw-linux-x86_64-img-zst`     | `elizaos-beta-2026.05.16-linux-x86_64.raw.img.zst` |
| `vm-linux-x86_64-qcow2`        | `elizaos-beta-2026.05.16-vm-linux-x86_64.qcow2.zst` |
| `vm-macos-silicon-utm`         | `elizaos-beta-2026.05.16-vm-macos-silicon.utm.zip` |
| `android-cuttlefish-x86_64-zip`| `elizaos-beta-2026.05.16-android-cf_x86_64_phone.zip` |
| `android-pixel-arm64-zip`      | `elizaos-beta-2026.05.16-android-pixel-arm64.zip` |

The current CI workflows produce **none** of these exact filenames:

- `build-linux-iso.yml` → `*.iso` (different format from the manifest's `.raw.img.zst`).
- `build-vm-image.yml` → `*.qcow2` / `*.ova` (different format from the manifest's `.qcow2.zst`).
- `android-release.yml` → consumer APK / AAB (not cuttlefish or Pixel boot bundles).
- No workflow produces macOS UTM bundles.

Until real build workflows produce artifacts with the manifest-declared filenames, the populate step will fail the strict gate, which means **no release manifest will ever be promoted to `available` by accident**. To cut the first real beta either:

1. Add build workflows that emit the exact filenames above, OR
2. Change the manifest filenames to match the existing `.iso` / `.qcow2` outputs, OR
3. Stage the artifacts manually under `_artifacts/` in the workflow before the populate step runs (escape hatch for one-off releases).

Discovery in the orchestrator is now driven by `manifest.artifacts[].filename` directly — so editing the manifest filenames is sufficient; no workflow code needs to be touched.
