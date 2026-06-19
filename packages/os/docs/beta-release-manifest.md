# elizaOS OS beta release manifest

The May 16 2026 beta release manifest lives at
`packages/os/release/beta-2026-05-16/manifest.json`. It is the source of truth
for downloadable OS artifacts, USB key presale terms, required validation
evidence, and checksum policy.

The manifest is release metadata, not automatic promotion evidence. Artifact
entries with `candidate` status, missing `sizeBytes`, or missing `sha256`
must not be presented as production-ready downloads.

## Beta terms

- Availability date: May 16 2026.
- Channel: beta.
- USB key presale: $49.
- USB key ship window: October 1-31 2026.
- Secure Boot: not supported for this beta unless a separately signed shim is
  published.

## Artifact classes

The manifest must include all public beta artifact classes:

- Raw image: primary compressed elizaOS Live image for USB flashing.
- VM image: QEMU/UTM bundles for evaluation and CI smoke tests.
- Android image: Cuttlefish and physical-device flashing bundles.

Each artifact entry records target platform, architecture, filename, download
URL, publication status, size, SHA-256, signature state, and required evidence.
Before public promotion, every non-withdrawn artifact should have a concrete
`sizeBytes` and `sha256`, plus validation evidence for its required gates.
For the Linux live image, that includes QEMU boot, real USB boot, internal
disk safety checks, and documented privacy/persistence limitations.

## Script workflow

Validate the manifest shape and beta invariants:

```sh
node packages/os/scripts/validate-release-manifest.mjs \
  --manifest packages/os/release/beta-2026-05-16/manifest.json
```

Generate checksums from a directory containing files named exactly as the
manifest artifacts:

```sh
node packages/os/scripts/generate-release-checksums.mjs \
  --manifest packages/os/release/beta-2026-05-16/manifest.json \
  --artifact-root /path/to/release-artifacts \
  --output packages/os/release/beta-2026-05-16/SHA256SUMS \
  --update-manifest
```

Verify local artifacts against `SHA256SUMS` and the manifest:

```sh
node packages/os/scripts/verify-release-checksums.mjs \
  --manifest packages/os/release/beta-2026-05-16/manifest.json \
  --artifact-root /path/to/release-artifacts \
  --checksums packages/os/release/beta-2026-05-16/SHA256SUMS
```

Collect a release evidence summary:

```sh
node packages/os/scripts/collect-release-evidence.mjs \
  --manifest packages/os/release/beta-2026-05-16/manifest.json
```

For promotion checks, add `--require-publishable-checksums` to validation or
evidence collection. That mode fails until every non-withdrawn artifact has a
real SHA-256 and size.

## Focused tests

```sh
node --test packages/os/scripts/__tests__/os-release-scripts.test.mjs
```
