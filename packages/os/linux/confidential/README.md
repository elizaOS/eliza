# Confidential guest inputs

Policy, kernel settings, dstack pins, and a Yocto data layer for confidential
images. This tree does not supply a complete guest build or an attestation agent.
`image-manifest.example.json` is example metadata, not release evidence.

The [layer](meta-elizaos/README.md) requires an external Yocto/meta-dstack build
context. Validate supplied manifests with `scripts/check-confidential-profile.ts
--manifest /absolute/manifest.json --release` from the OS package directory.
The release check requires actual image and reproducibility evidence.
