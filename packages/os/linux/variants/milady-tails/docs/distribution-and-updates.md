# Distribution and Updates

This is the product plan for shipping elizaOS Live without making users
download and reflash a full ISO for every app, runtime, or model change.
It distinguishes the demo path from the production path.

## What elizaOS Live is

elizaOS Live is a Linux live-USB distribution built on Tails live-OS
plumbing. It is not an installed package on a normal desktop. Users boot
the USB, see elizaOS Live branding, optionally unlock encrypted
persistence, and land in a normal desktop with the elizaOS app running as
the home surface.

It is valid to call this a distro, with precision: **a Tails-derived
live-USB distribution**. The release process must respect Tails'
security/update model, GPL posture, and amnesic design. Primary user
surfaces should not present derivative branding; attribution belongs in
credits, license files, and about/legal views.

## Current Demo State

The current branch is a demo/productization branch:

- Source overlays exist for elizaOS branding, Privacy Mode, bundled app
  install/autostart, capability broker basics, and Persistent Storage.
- Static smoke checks are part of the demo gate and must pass before
  promotion.
- A rebuilt ISO still has to pass QEMU greeter, desktop, app launch,
  privacy, persistence, and real-USB validation before it is demo-complete.
- Production release infrastructure is not finished: signing, update
  manifests, rollback, GUI flasher, SBOM/license automation, and
  enterprise policy are still backlog items.

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
USB. The ISO remains the factory image; the persistent app bundle is the
active image only after signature verification and activation.

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

- adapt the Tails incremental-update-kit pattern for signed binary deltas
- provide a signed full-image update fallback for major or unsafe deltas
- let the elizaOS app write a new USB through the same removable-disk
  guard rails as `scripts/usb-write.sh`

The safe v1 path is: signed full ISO + guarded writer. The better v1.x
path is: signed incremental update kits for OS deltas, plus app/runtime
updates through persistence. The updater must always verify:

- current version and update ring
- signed update manifest
- image or delta signature
- enough free space in persistence or target USB
- rollback path to the read-only factory image or previous active bundle
- migration steps for Persistent Storage paths

Users should only need a new full ISO for first install, major base-OS
upgrades, failed delta fallback, or when they intentionally create a fresh
USB.

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

Balena Etcher remains acceptable as a documented fallback, but the product
should not depend on it. The production flasher should be a signed
cross-platform app plus a CLI with the same policy:

- macOS: signed/notarized package, Disk Arbitration or `diskutil`, raw
  device writes, explicit authorization prompt
- Windows: signed installer, physical-drive enumeration, lock/dismount
  target volumes, clear warning about post-write format prompts
- Linux: AppImage or archive plus CLI, `lsblk --json` enumeration, polkit
  or root only for the write step

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
- enterprise rings are supported: canary, pilot, broad, emergency rollback
- policy can pin approved app/runtime/model versions
- internal mirrors can serve ISO, delta, app, and model artifacts
- fleet evidence records update result, device class, artifact hash, and
  failure reason without recording user secrets

## Demo Positioning

For the current demo, the correct statement is:

> This is an elizaOS Live USB prototype that preserves the underlying
> live-OS security model, boots into an elizaOS-branded experience, and
> bundles the elizaOS app/runtime. The production update system is planned
> but not finished; current demo builds still require rebuilding the ISO for
> OS/base changes, while app/model update channels are production backlog.
