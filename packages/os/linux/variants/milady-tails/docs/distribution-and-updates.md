# Distribution and Updates

This is the product plan for shipping elizaOS Live without making every
user download and reflash a full ISO for every app/runtime change.

## What elizaOS Live is

elizaOS Live is a Linux live-USB distribution based on the Tails live-OS
stack. It is not an installed package on a normal desktop. Users boot the
USB, get the elizaOS-branded greeter, unlock optional encrypted
persistence, and land in a normal desktop with the elizaOS app running as
the home surface.

It is valid to call this a distro, with precision: **a Tails-derived
live-USB distribution**. The release process must respect Tails'
security/update model, GPL posture, and amnesic design.

## Release Artifacts

Every public release should publish:

- `elizaos-live-$VERSION.iso`
- SHA256/SHA512 checksums
- detached signature for the ISO and checksum file
- SBOM for OS packages and bundled app/runtime packages
- license/CREDITS bundle, including Tails attribution
- release notes with known gaps and hardware notes
- a machine-readable update manifest

The build should be reproducible enough that a second builder can verify
the ISO contents, even if exact byte-for-byte reproducibility is a later
milestone.

## Update Layers

### 1. App/runtime updates

The bundled app changes more often than the OS. For production, ship a
signed app bundle update channel:

- downloads only after explicit user approval or enterprise policy
- verifies signature before activation
- stores the updated bundle in encrypted Persistent Storage
- keeps the read-only ISO bundle as rollback/factory fallback
- never writes app state when booted in amnesia unless the user opts into
  a temporary RAM-only update for that session

This gives users frequent elizaOS app improvements without reflashing the
USB.

### 2. Model updates

Do not bake large/private models into every ISO by default. The ISO should
ship the runtime and a model catalog; onboarding should offer:

- cloud/provider sign-in
- local-only mode with no model yet
- signed Eliza-1 or other model download
- enterprise-managed model mirror

Downloaded models belong in encrypted Persistent Storage. In amnesia mode,
model downloads are RAM-only and disappear at shutdown.

### 3. OS/base updates

Base OS updates are different because the root filesystem is a signed
live image. Production options:

- adapt the Tails incremental-update pattern for signed binary deltas
- provide a full-image update fallback
- let the elizaOS app write a new USB through the same removable-disk
  guard rails as `scripts/usb-write.sh`

The safe v1 path is: signed full ISO + guarded writer. The better v1.x
path is: signed incremental update kits for OS deltas, plus app/runtime
updates through persistence.

## Built-In USB Writer

The developer script already does the right kind of checks: it accepts a
specific target device, verifies that it is removable, refuses mounted
targets, and writes the ISO directly. The desktop app should reuse that
same policy before offering a GUI writer:

- show only removable drives
- display size, model, serial, and current mounts
- require a destructive confirmation with the exact device name
- refuse the boot device unless explicitly doing a supported clone/update
  flow
- write, sync, verify checksum, and show the result

Balena Etcher remains fine for users, but the product should not depend on
it.

## Distribution Channels

- **Developer/nightly:** draft GitHub releases, unsigned or test-signed,
  explicit "not for secrets" warning.
- **Beta:** signed ISO, known-gaps page, hardware test matrix, feedback
  channel.
- **Stable:** signed ISO, update manifest, model manifest, SBOM, license
  bundle, rollback instructions.
- **Enterprise:** managed update policy, internal mirror, signed model
  catalog, fleet compatibility notes, support window.

## Enterprise Requirements

Before this is enterprise-grade:

- release signing keys are separated from developer machines
- CI builds and archives artifacts
- SBOM and license scans are mandatory
- CVE scan gates release
- root capability policy is reviewed and versioned
- update manifests are signed and revocable
- app/runtime update rollback is tested
- persistent-storage migrations are tested across versions
- USB writer has destructive-action guard rails and audit logs

## Demo Positioning

For the current demo, the correct statement is:

> This is an elizaOS Live USB prototype that preserves the Tails desktop
> and security model, boots into an elizaOS-branded experience, and bundles
> the elizaOS app/runtime. The production update system is planned but not
> finished; current demo builds still require rebuilding the ISO for OS
> changes.
