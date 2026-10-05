# Persistent Linux image

Debian trixie GNOME disk images, assembled by mkosi 25.3 or newer. From the
repository root, use the pinned container builder:

```bash
make -C packages/os/linux/elizaos build ARCH=amd64 PROFILE=gui
make -C packages/os/linux/elizaos mkosi-summary ARCH=amd64 PROFILE=gui
bun run --cwd packages/os verify:linux
```

Images have an EFI system partition, system and recovery partitions, and a final
home partition that grows on first boot. USB boot/persistence and internal-disk
installation require separate runtime qualification. Secure Boot is unsupported
on riscv64; other release targets require configured signing keys.

Recovery keeps its factory root read-only and uses an ephemeral `/var` for service
state. Recovery logs and state are lost at shutdown; export diagnostics before rebooting.

For native builders, `../../../scripts/linux/mkosi-linux-build.py --help` describes artifact,
snapshot, preflight, and evidence arguments. Supply new output-directory and
evidence paths for each run; package caches use a separate option. Release mode requires signed desktop
artifacts and the control-broker sources consumed by `mkosi.postinst.chroot`.
Native preflight and image assembly share [the required control inputs](../../control-inputs.list);
missing release inputs are rejected before assembly.
Development builds may omit those components and cannot establish release readiness.

Browser integrity staging runs only after the existing Ed25519 desktop verifier
extracts the authenticated archive. Its private receipt binds the browser's source
commit and architecture to that same outer manifest. There is no separate browser
signing key. The archive must contain `browser/browser-artifact-manifest.json` and
a complete browser payload; release builds reject absence, and any partial payload
fails in every mode. Development/fixture absence records `unavailable` in
`/usr/share/elizaos/browser-staging-status.json`.

The inner schema v1 fields are `architecture`, `sourceCommit`, `extensionId`,
`node`, `chromium`, and `files`, plus `schemaVersion`. The extension ID is
`pmldpcoefklbdbgmggcejkfoinmjfeio`. Node provenance requires version `24.15.0`,
its exact official Linux x64/arm64 archive URL (`sourceArchive`) and archive
SHA-256 (`sourceArchiveSha256`); riscv64 has no admitted pinned Node artifact.
Chromium provenance supplies its 40-character `revision` and four-part `version`.
Every payload file except the manifest has a relative-path inventory entry with
`sha256`, `bytes`, and an exact octal `mode` (`0644`/`0755`). Payload directories must be `0755`; setid bits, links, and
unlisted files are rejected. The browser must support its default user-namespace
sandbox; this stager neither grants a setuid sandbox nor disables sandboxing.

Required paths are `node/bin/node`, `native-host.mjs`, `chromium/chrome`,
`chromium/resources.pak`, `chromium/icudtl.dat`, and the component generator's
`provenance/eliza-component-overlay.json` plus `provenance/eliza-component.patch`.
The six reviewed extension resources must also appear under `component/`, matching
the overlay report's hashes. The report must identify Linux, the same Chromium
revision and extension, and no unrestricted native-host allowlist bypass. Native
ELF inputs must match the image architecture. Version/source metadata is an
assertion of the authenticated archive publisher; staging does not execute it.

Staging registers a root-owned system native host, `/usr/bin/chromium`, and a
system desktop MIME entry. It adds no browser flags or user defaults and refuses
to overwrite unrelated system registrations. Integrity staging always records
`releaseQualified: false`: an actual owned Chromium build and matching runtime
proof of embedded-component verification and complete native control remain
separate release requirements. No qualifying browser artifact is provided here.
Run `bun run --cwd packages/os verify:linux` with Python's `cryptography` package
installed to include signed-artifact and browser-staging regression tests.

Verified browser staging also adds Bitwarden's exact Web Store extension ID with
`normal_installed` policy in `/etc/chromium/policies/managed/elizaos-bitwarden.json`.
Users can disable it. This requests an online Web Store installation; it does not
bundle Bitwarden offline, configure an account/server, or prove runtime policy
ingestion. Existing overlapping `ExtensionSettings` policies are rejected rather
than merged by ambiguous file precedence.
