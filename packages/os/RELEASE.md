# elizaOS — Release Runbook

Short, mechanical steps for cutting a new OS release. Anything not on this list is out of scope for the release engineer.

## Layout

- `release/<channel>-<date>/manifest.json` — primary manifest (raw image + VM + Android bundle entries).
- `release/<channel>-<date>/android-release-manifest.json` — Android per-partition manifest (`boot.img`, `vendor_boot.img`, `super.img`).
- `scripts/update-release-manifest.mjs` — sets `sha256`, `sizeBytes`, `downloadUrl`, status on one artifact entry.
- `scripts/validate-release-manifest.mjs` — schema check; pass `--require-publishable-checksums` for strict mode.
- `scripts/generate-release-checksums.mjs` — fills the manifest by hashing local artifact files.
- `android/installer/scripts/validate-release-manifest.mjs` — separate validator for the Android per-partition manifest. Rejects all-zero placeholder hashes.

## Steps

1. **Build artifacts.**
   - Linux ISO → `.github/workflows/build-linux-iso.yml` (`*.iso`).
   - VM images → `.github/workflows/build-vm-image.yml` (`*.qcow2`, `*.ova`).
   - Android consumer APK/AAB → `.github/workflows/android-release.yml`.
   - **Not produced by CI today**: cuttlefish images (`cf_x86_64*.zip`), Pixel boot bundles (`pixel-arm64*.zip`), macOS UTM bundles (`*.utm.zip`), `.raw.img.zst`, `.qcow2.zst`. Until a workflow exists, these must be built and uploaded manually to the workflow's `_artifacts` staging directory before the populate step runs.

2. **Stage and populate.** The `populate-and-validate-manifest` job in `elizaos-os-full-release.yml` downloads all uploaded artifacts, then for each manifest entry searches `_artifacts` by `filename` and runs `update-release-manifest.mjs`. If filenames in the manifest don't match what the builds produce, fix the manifest filenames first — discovery is filename-driven.

3. **Strict-validate.** `validate-release-manifest.mjs --require-publishable-checksums` must pass. Any artifact without a real sha256 (including the all-zero placeholder) fails the gate.

4. **Promote.** Set `release.status = "available"`. The orchestrator does this in a step that only runs after the strict gate passes.

5. **Android per-partition manifest.** Generate sha256 for each `.img`, write into `android-release-manifest.json`, then run `android/installer/scripts/validate-release-manifest.mjs <path>`. Both all-zero hashes and the `sizeBytes: 1` placeholder are rejected.

6. **Tag.** Create the git tag (`vX.Y.Z`). The `release: [created]` trigger runs the full orchestrator end-to-end.

## What the validators guarantee

- `sha256` must be 64 lowercase hex AND must not be all zeros.
- `sizeBytes` must be a positive integer (Android: must be > 1, to reject the placeholder).
- Strict mode (`--require-publishable-checksums`) requires both fields populated for every non-withdrawn artifact.

## When you see warnings

`validate-release-manifest.mjs` without `--require-publishable-checksums` warns on missing sha256 but exits 0. That is intentional — the file is checked in pre-release with `sha256: null` so the manifest schema is reviewable. The CI orchestrator always uses strict mode for the gating step.
