# Verify an elizaOS Live ISO download

When you download an elizaOS Live ISO from a GitHub Release, you should
verify that the file you received is the file elizaOS actually built
and signed — before you flash it to a USB stick and boot from it. This
guide walks through the three checks every release publishes (once the
release pipeline is green; see [ci-cd-prod-roadmap.md](./ci-cd-prod-roadmap.md)
for the current status).

## What ships with each release

Every elizaOS Live release on https://github.com/elizaOS/eliza/releases
includes these files per architecture:

| File | Purpose |
| --- | --- |
| `elizaos-live-<channel>-<date>-<arch>.iso` | The ISO image you flash to USB. |
| `elizaos-live-<channel>-<date>-<arch>.iso.sha256` | SHA-256 checksum of the ISO. |
| `elizaos-live-<channel>-<date>-<arch>.iso.spdx.json` | SPDX 2.3 SBOM listing every Debian package inside the ISO. |
| Sigstore in-toto attestation | Mintable via GitHub OIDC; verify with `gh attestation verify` (no separate file). |

`<channel>` is `nightly`, `beta`, or `stable`. `<arch>` is `amd64`
(and `arm64` once Phase 3a stabilizes; see [PR #7971](https://github.com/elizaOS/eliza/pull/7971)).

## Step 1 — Verify the SHA-256 checksum

This catches a corrupted download or an obvious wrong-file mistake.
It does **not** prove the ISO came from elizaOS — see Step 2 for that.

```sh
# Download the ISO + its .sha256 sidecar from the release page first.
sha256sum -c elizaos-live-stable-2026.05.25-amd64.iso.sha256
```

Expected output:

```
elizaos-live-stable-2026.05.25-amd64.iso: OK
```

If you see `FAILED` instead, the file is corrupted (re-download) or
tampered (do not flash; report it on the issue tracker).

## Step 2 — Verify the SLSA build provenance with `gh attestation verify`

This is the cryptographic proof that elizaOS's official CI built this
exact ISO. Every nightly + release run mints a [SLSA build
provenance](https://slsa.dev/spec/v1.0/provenance) attestation, signed
via GitHub's OIDC token to [Sigstore](https://www.sigstore.dev/) (no
long-lived keys, no PGP key management). The attestation binds the ISO
file's SHA-256 to the repo + workflow + commit that produced it.

You need [GitHub CLI](https://cli.github.com/) (`gh`) ≥ 2.49.0:

```sh
gh attestation verify elizaos-live-stable-2026.05.25-amd64.iso \
    --owner elizaOS
```

Expected output:

```
Loaded digest sha256:6019452a... for file://elizaos-live-stable-2026.05.25-amd64.iso
Loaded 1 attestation from GitHub API

The following policy criteria will be enforced:
- OIDC Issuer must match:................... https://token.actions.githubusercontent.com
- Source Repository Owner URI must match:... https://github.com/elizaOS
- Predicate type must match:................ https://slsa.dev/provenance/v1
- Subject Alternative Name must match regex: (?i)^https://github.com/elizaOS/

✓ Verification succeeded!

sha256:6019452a... was attested by:
REPO          PREDICATE_TYPE                  WORKFLOW
elizaOS/eliza https://slsa.dev/provenance/v1  .github/workflows/build-linux-iso.yml@refs/heads/develop
```

The `WORKFLOW` field tells you exactly which workflow + branch built
the ISO. Cross-check it against
https://github.com/elizaOS/eliza/blob/develop/.github/workflows/build-linux-iso.yml
to confirm the build pipeline you trust matches the build pipeline
that produced your download.

### Locking down the verification further

For higher assurance, pin the workflow path + ref:

```sh
gh attestation verify elizaos-live-stable-2026.05.25-amd64.iso \
    --owner elizaOS \
    --source-ref refs/tags/v2.0.4 \
    --signer-workflow elizaOS/eliza/.github/workflows/build-linux-iso.yml@refs/tags/v2.0.4
```

This rejects any attestation that came from a different branch, a
different workflow file, or a fork. Recommended for security-sensitive
deployments.

### Offline verification

`gh attestation verify` can also work offline if you pre-downloaded
the attestation:

```sh
# Online: download the attestation JSON once
gh attestation download elizaos-live-stable-2026.05.25-amd64.iso \
    --owner elizaOS \
    --output-file attestation.json

# Offline: verify against the local bundle
gh attestation verify elizaos-live-stable-2026.05.25-amd64.iso \
    --owner elizaOS \
    --bundle attestation.json
```

This is useful when flashing on an air-gapped machine.

## Step 3 — Inspect the SBOM (optional but recommended)

The `.spdx.json` file lists every Debian package baked into the ISO,
including the apt cache snapshot date that fixed package versions.
This is what you would feed into your own vulnerability scanner if
you run one:

```sh
# Quick: how many packages?
jq '.packages | length' elizaos-live-stable-2026.05.25-amd64.iso.spdx.json

# All package names + versions
jq -r '.packages[] | "\(.name) \(.versionInfo)"' \
    elizaos-live-stable-2026.05.25-amd64.iso.spdx.json | sort

# Feed into Grype for CVE scan (one-time install: brew install grype OR
# `curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh`)
grype sbom:elizaos-live-stable-2026.05.25-amd64.iso.spdx.json
```

The SBOM is generated by [anchore/sbom-action](https://github.com/anchore/sbom-action)
(driving [syft](https://github.com/anchore/syft) under the hood) from
the Debian package database inside the ISO's squashfs root.

## What "verified" actually guarantees

Pass all three checks above and you know:

1. The ISO bytes are exactly what elizaOS published (SHA-256 match).
2. Those bytes came from a build run inside the elizaOS GitHub
   organization, executed by the public workflow at the SHA recorded
   in the attestation (SLSA provenance).
3. The package set inside the ISO is exactly what the SBOM declares,
   pinned to the build's APT snapshot date.

It does **not** guarantee:

- That GitHub Actions or Sigstore are themselves uncompromised (those
  are the trust roots). Pin to a known-good attestation date if you
  want to mitigate.
- That the bundled application code is bug-free or contains no
  vulnerabilities. Run the Grype scan above for CVE coverage of the
  Debian package set; for elizaOS app-layer issues, see
  https://github.com/elizaOS/eliza/security.

## When verification fails

| Failure | Cause | Fix |
| --- | --- | --- |
| `gh attestation verify` returns "no attestations found" | Release predates the SLSA pipeline going green (pre-2026-05). | Use SHA-256 check only; or wait for a re-built release. |
| `--owner elizaOS` policy fails | You're pointing at a fork's release, not elizaOS/eliza. | Download from https://github.com/elizaOS/eliza/releases — not a fork. |
| Workflow name doesn't match `.github/workflows/build-linux-iso.yml` | The ISO came from a different CI job (e.g. `elizaos-os-full-release.yml`). | That's currently expected for tag-triggered releases; the workflow you trust depends on which channel you downloaded. Open an issue if unsure. |
| SHA-256 mismatch but attestation verifies | The `.sha256` sidecar was tampered. The attestation has the real hash inside it. | Use the hash from `gh attestation verify` output as the source of truth. |
| Everything passes but the ISO won't boot | Verification only proves provenance, not bootability. | Try a known-good USB flasher (the `dd` recipe in README); confirm BIOS/UEFI mode matches your hardware. |

## Related

- [ci-cd-prod-roadmap.md](./ci-cd-prod-roadmap.md) — why some of the
  scaffolding above doesn't yet produce releases (8+ days of nightly
  red as of 2026-05-25; PR #7950 unblocks).
- [actions/attest-build-provenance](https://github.com/actions/attest-build-provenance)
  — what the workflow uses to mint attestations.
- [SLSA v1.0 spec](https://slsa.dev/spec/v1.0/) — the threat model
  the attestation actually defends against.
- [Sigstore docs](https://docs.sigstore.dev/) — keyless signing
  background.
