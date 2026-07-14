# Flathub publication status

Flathub publication is disabled. The checked-in Flatpak manifests build
reviewed x86_64 side-load bundles, but they consume a generated `runtime/`
directory that is intentionally ignored by git. Flathub's remote builder
therefore cannot fetch or reproduce the application payload from those
manifests.

`flatpak-publish.yml` never submits anything to Flathub. It preserves the
`release-all.yml` version/tag call contract and delegates to
`publish-packages.yml`, which builds the manifest from the exact release tag,
installs the bundle, smoke-tests the installed CLI and service, and attaches
the verified x86_64 side-load bundle to the GitHub release. That artifact must
not be described as a Flathub publication.

## Credentials

No Flathub credential is currently consumed. Do not create an
`FLATHUB_TOKEN` for the disabled workflow. A token cannot make a local-only
manifest reproducible, and falling back to this repository's `GITHUB_TOKEN`
would not authorize writes to an external fork.

## Requirements before enabling publication

Re-enable the workflow only after all of these are complete:

1. Replace the ignored `runtime/` source with immutable, publicly fetchable
   sources whose checksums reproduce the locked production closure.
2. Build, bundle, install, and boot the submission manifest from a clean
   remote-builder-equivalent environment, including Node provenance and H.264
   encode/probe checks.
3. Advertise only architectures backed by native build-and-boot evidence.
4. Complete the human-reviewed initial Flathub submission and obtain the
   per-app repository.
5. Provision a dedicated fine-grained credential for that repository and fail
   before checkout when it is absent; never fall back to `GITHUB_TOKEN`.
6. Update the exact structured source fields in the Flathub manifest and reject
   a no-op or ambiguous edit. Blind `sed` replacement is not acceptable.
7. Open and manually review the real update PR and resulting Flathub build.

## Current side-load verification

Use `test-flatpak.yml` for both the hardened and direct profiles. It builds a
real OSTree repository and bundle, reinstalls the exact commit, proves the
locked Node runtime and license/provenance files, exercises the CLI and service,
and verifies H.264 through the Freedesktop FFmpeg extension.

See
[`packages/app-core/packaging/flatpak/README.md`](../../app-core/packaging/flatpak/README.md)
for the sandbox and remote-build boundary.
