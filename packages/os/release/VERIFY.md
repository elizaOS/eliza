# Verifying an elizaOS release

This page documents the verification stack the release pipeline ships
and how to drive it end-to-end from a download directory.

If you only want one command, run:

```sh
bash packages/os/scripts/verify-release.sh path/to/your/downloads
```

That script walks every layer below in order and exits non-zero on the
first hard failure.

---

## What the release ships

For a published release, the GitHub Release page contains:

| File | What it is | Required? |
| --- | --- | --- |
| `*.raw.img.zst`, `*.qcow2.zst`, `*.utm.zip`, `*-android-*.zip` | Release artifacts | yes |
| `SHA256SUMS` | Canonical aggregated checksums file | yes |
| `*.spdx.json` | SPDX SBOM (Linux image only, today) | once landed |
| `SHA256SUMS.asc` _(future)_ | Detached GPG signature on `SHA256SUMS` | once the signing-key RFC lands |

Artifact filenames follow the pattern:

```
elizaos-{channel}-{date}-{platform}-{arch}.{ext}
```

For example: `elizaos-beta-2026.05.16-linux-x86_64.raw.img.zst`

Per-artifact GitHub artifact attestations (SLSA build provenance via
Sigstore) live in GitHub, not the release tarball. Verify them with the
`gh` CLI as shown below.

## Layer 1 — `SHA256SUMS` roundtrip (REQUIRED)

The cheapest, most universal check. Available on any Unix.

```sh
cd path/to/your/downloads

# Linux (coreutils):
sha256sum -c SHA256SUMS --ignore-missing

# macOS:
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Expected output (one line per artifact present in the directory):

```
elizaos-beta-2026.05.16-linux-x86_64.raw.img.zst: OK
elizaos-beta-2026.05.16-vm-linux-x86_64.qcow2.zst: OK
elizaos-beta-2026.05.16-vm-macos-silicon.utm.zip: OK
```

If any line says `FAILED`, the artifact has been modified in transit
(or corrupted). Re-download.

## Layer 2 — GitHub artifact attestations (RECOMMENDED)

Each release artifact carries a Sigstore-signed SLSA build provenance
attestation, minted at build time via GitHub OIDC. Verify with the
[`gh` CLI](https://cli.github.com/):

```sh
gh attestation verify elizaos-beta-2026.05.16-linux-x86_64.raw.img.zst --owner elizaOS
gh attestation verify elizaos-beta-2026.05.16-vm-linux-x86_64.qcow2.zst --owner elizaOS
gh attestation verify SHA256SUMS                                           --owner elizaOS
```

Replace the date and channel with the actual release values. Each command
will report the signing identity, the workflow that produced the artifact,
the source commit, and the Sigstore Rekor entry. A passing verification
means:

- the artifact was built by the elizaOS GitHub repository
- the build used the workflow source code at the recorded commit
- the in-toto provenance has not been tampered with since signing

If verification fails or returns "no attestations found", treat the
download as unverified.

## Layer 3 — GPG signature on `SHA256SUMS` (FUTURE)

Once the [signing-key RFC](https://github.com/elizaOS/eliza) lands,
each release will additionally ship a detached GPG signature:

```sh
# Import the elizaOS release key (one-time setup; fingerprint will be
# published alongside the key once the RFC lands):
gpg --import packages/os/release/keys/elizaos-release.asc

# Per release:
gpg --verify SHA256SUMS.asc SHA256SUMS
```

Until the RFC is resolved, this layer is N/A and the verification
helper will print a `[--]` notice and skip it.

## Layer 4 — SBOM inspection (OPTIONAL)

Each Linux image release ships an SPDX-JSON SBOM enumerating every
package in the image. Get a quick package count with:

```sh
jq '.packages | length' elizaos-beta-2026.05.16-linux-x86_64.spdx.json
```

For vulnerability scanning, feed the SBOM into [Grype](https://github.com/anchore/grype):

```sh
grype sbom:elizaos-beta-2026.05.16-linux-x86_64.spdx.json
```

## The one-command runner

`packages/os/scripts/verify-release.sh` walks all four layers in order.
It exits:

| Code | Meaning |
| --- | --- |
| `0` | every required check passed (optional layers may have been skipped) |
| `1` | `SHA256SUMS` missing or roundtrip failed |
| `2` | an optional layer ran and failed (invalid attestation, bad GPG sig) |

It depends only on `sha256sum` (Linux) or `shasum` (macOS) for the
required layer. `gh`, `gpg`, and `jq` enable the optional layers and
produce notices when missing rather than failing.

## Reporting verification problems

If you hit a verification failure on a fresh download from an official
release page, open an issue with:

- the release tag (e.g. `v2.0.1`)
- the failing layer (1 / 2 / 3 / 4)
- the exact command output (truncate large logs)
- whether you mirror-downloaded or pulled directly from GitHub

False positives matter: a confirmed verification failure would be a
serious supply-chain alert.
