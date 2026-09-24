# release: provision offline trust roots and promote exact tested Linux images

Repository: `elizaOS/os`

Suggested labels: `release`, `security`, `signing`, `release-blocker`

## Work

- Approve the implemented Ed25519 release signature format: public key encoded
  as PEM or DER SPKI, independently pinned lowercase SHA-256 of canonical DER
  SPKI, and detached raw or canonical-base64 64-byte signatures.
- For Linux desktop artifacts, sign two distinct byte strings with that trust
  root: `desktop-artifact-manifest.json.sig` authenticates the exact adjacent
  `desktop-artifact-manifest.json` bytes, while the manifest's `signature`
  file authenticates the exact named archive bytes. Neither signature is a
  signature over parsed, normalized, or reserialized JSON.
- Generate production roots offline; do not create them in CI or commit them.
- Embed only the public trust root in production installer/application builds.
- Define threshold ownership, rotation, revocation, expiry, rollback/freeze
  protection, and emergency recovery.
- Sign exact manifest bytes and desktop/image artifacts.
- Publish SBOM, provenance, package manifest, build inputs, hashes, and test
  evidence.
- Promote a previously tested digest. A release event must never rebuild from a
  mutable branch.

## Acceptance criteria

- Valid signatures verify on macOS, Windows, and Linux.
- Missing, linked, modified, noncanonical, or wrong-key manifest and archive
  signatures fail before metadata or payload activation.
- Wrong key, modified bytes, truncated signature, expired metadata, lower
  sequence, frozen timestamp, revoked key, and unknown key all fail closed.
- No private signing key appears in source, Actions artifacts, logs, caches, or
  runner filesystems after completion.
- Root rotation and lost/compromised online-key recovery are exercised.
- The installer, mkosi image integration, and release publication use the same
  documented trust contract.
- Published URLs resolve to the exact hardware-qualified digests.
