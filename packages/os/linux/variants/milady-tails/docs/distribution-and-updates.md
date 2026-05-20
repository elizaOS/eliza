# Distribution and Updates

This is the product plan for shipping elizaOS Live as a real USB distro
without forcing users to re-download and reflash a full ISO for every app,
runtime, or model change.

The current branch is not production-complete. It has source overlays for
the live OS, a staged app runtime, and a signed-runtime verifier foundation,
but production release keys, downloader services, revocation, enterprise
mirrors, policy enforcement, and rollback tests do not exist yet. Demo builds
must be described as prototypes until those pieces are built and validated.

## What elizaOS Live is

elizaOS Live is a Linux live-USB distribution built on Tails live-OS
plumbing. Users boot the USB, see elizaOS Live branding, optionally unlock
encrypted Persistent Storage, and land in a normal desktop with the elizaOS
app running as the home surface.

It is valid to call this a distro, with precision: **a Tails-derived
live-USB distribution**. The release process must respect Tails' update
model, GPL posture, amnesic design, and Persistent Storage semantics.
Primary user surfaces should present elizaOS Live; Tails attribution belongs
in credits, license files, and about/legal views.

## Current Demo State

The current branch is a demo/productization branch:

- Source overlays exist for elizaOS branding, Privacy Mode, bundled app
  install/systemd launch, capability broker basics, Persistent Storage, and
  a checked signed-runtime verifier foundation.
- Static smoke checks are part of the demo gate and must pass before
  promotion.
- The latest validated local ISO artifact has passed QEMU greeter/desktop/app
  onboarding validation. A prior artifact passed guarded USB flash/readback,
  so rebuild/revalidate the exact release commit if the branch moves and
  repeat USB flash/readback before calling HEAD final.
- Privacy behavior, real hardware USB boot, and real USB Persistent Storage
  behavior still need validation before production claims.
- Production release infrastructure is missing: release keys, manifest
  signing, artifact hosting, updater UI, app/runtime channel, model catalog,
  rollback tests, GUI flasher, SBOM/license automation, provenance
  attestation, and enterprise policy/mirror support.

## Release Architecture

Production distribution has three update layers. They share trust roots and
policy, but they activate differently:

1. **Factory ISO runtime:** the read-only app/runtime baked into the ISO.
   This is always available and is the fallback if persistence is absent,
   corrupt, revoked, or fails verification.
2. **Verified persistent runtime:** an app/runtime bundle stored in
   encrypted Persistent Storage. It is selected only after boot-time
   signature and hash verification against a signed manifest. Failed
   verification falls back to the factory ISO runtime and records a local
   non-secret failure reason.
3. **OS image updates:** signed full ISOs at minimum, with signed
   incremental update kits or binary deltas when safe. OS updates are
   separate from app/runtime updates because the root filesystem is a signed
   live image.

The boot-time runtime selector must be small, deterministic, and independent
of the app it launches:

- read the channel policy from ISO defaults plus optional enterprise policy
- inspect Persistent Storage only after it is unlocked by Tails' normal flow
- verify the persistent runtime manifest signature
- verify every activated file by content hash or bundle hash
- enforce monotonic version/revocation rules for the selected channel
- launch the persistent runtime only if all checks pass
- otherwise launch `/opt/milady` from the ISO and show a recoverable status
  in the app after desktop startup

No downloaded runtime becomes active merely because it exists on disk.

## Release Artifacts

Every public production release should publish:

- `elizaos-live-$VERSION.iso`
- SHA256/SHA512 checksums
- detached signatures for the ISO and checksum file
- signed update manifest for the release channel
- signed model catalog manifest
- app/runtime bundle manifest when a runtime is promoted with the ISO
- SBOM for OS packages and bundled app/runtime packages
- provenance attestation for builder identity, source revision, dependency
  snapshot, artifact hash, and signing event
- license/CREDITS bundle, including Tails attribution
- release notes with known gaps, hardware notes, migration notes, and
  rollback instructions

The build should be reproducible enough that a second builder can verify
the ISO contents. Exact byte-for-byte reproducibility is a later milestone,
but dependency snapshots, source revisions, and generated artifact hashes
must be recorded before stable release.

## Channels and Promotion

Channels are part of the artifact identity. The app/runtime updater, model
catalog, OS updater, and enterprise mirror must all agree on the active
channel.

| Channel | Purpose | Signing state | User posture |
|---|---|---|---|
| `developer` | local and CI smoke artifacts | unsigned or test-signed | never for secrets |
| `nightly` | automated integration builds | test or nightly key | opt-in testers only |
| `beta` | candidate builds with known gaps | production key or release-candidate key | opt-in with rollback path |
| `stable` | supported public releases | production key | default public channel |
| `enterprise-canary` | first internal fleet ring | enterprise key or policy-pinned public key | small managed ring |
| `enterprise-pilot` | broader managed rollout | enterprise policy-pinned | representative users |
| `enterprise-broad` | normal managed fleet | enterprise policy-pinned | default managed channel |
| `enterprise-rollback` | emergency pin or downgrade target | enterprise policy-pinned | admin-controlled only |

Promotion rules:

- no artifact moves to beta or stable without signed manifests, checksums,
  SBOM, license bundle, and known-gaps notes
- no app/runtime bundle is promoted without boot-time verifier tests,
  persistence migration tests, and rollback tests to the ISO runtime
- no model catalog entry is promoted without signed metadata, content hash,
  license/source metadata, hardware requirements, and provider policy notes
- no OS update is promoted without QEMU boot, real-USB boot, persistence,
  privacy-mode, and recovery-path validation
- enterprise promotion can be slower than public promotion and can pin older
  app/runtime/model versions

## App and Runtime Updates

The bundled app changes more often than the OS. Production should ship a
signed app/runtime update channel so users can receive app fixes without
reflashing the USB.

The update format should be a versioned bundle plus signed manifest:

- bundle id, version, channel, minimum OS version, maximum tested OS version
- content hash for the complete bundle and optionally per-file hashes
- dependency/runtime ABI marker for Electron/Electrobun/CEF/Bun boundaries
- migration script list with hashes and explicit rollback behavior
- signer identity, signature timestamp, expiration, and revocation metadata

Activation flow:

1. The running app checks the signed channel manifest after user approval or
   enterprise policy approval.
2. The bundle downloads to a staging directory in encrypted Persistent
   Storage. In amnesia mode, only an explicit temporary RAM-only update is
   allowed, and it disappears at shutdown.
3. The downloader verifies manifest signature and bundle hash before staging
   completes.
4. Boot-time verification writes selector state under `/run/elizaos` and
   points only at a root-owned materialized runtime copy.
5. On the next launch or reboot, the boot-time selector re-verifies the
   signed manifest, complete file inventory, materialized copy, and rollback
   state before choosing it.
6. The root-owned health checker promotes a candidate after local agent and
   renderer health checks pass. Timeout leaves the candidate unpromoted by
   default; explicit rollback marking is gated by health-check policy.

This architecture preserves a factory runtime in the ISO while allowing fast
app/runtime updates from persistence. The current branch implements the
verifier/selector foundation, but not the downloader, production keyring,
revocation metadata, model downloader, production health UX, or
release-hosting service.

## Model Catalog and Downloads

Large or private models should not be baked into every ISO by default. The
ISO should ship runtime support plus a signed model catalog. Onboarding
should offer:

- cloud/provider sign-in
- local-only mode with no model yet
- signed Eliza-1 or other local model download
- enterprise-managed model mirror and approved-model policy

The model catalog is a signed manifest, not a marketing list. Each entry
needs:

- model id, version, format, quantization, size, and hardware requirements
- source URL or mirror path
- content hash and detached signature where available
- license, redistribution status, and usage restrictions
- minimum runtime version and supported acceleration backends
- privacy notes, including whether inference is local-only or provider-backed
- revocation or deprecation metadata

Downloaded models belong in encrypted Persistent Storage. In amnesia mode,
downloads are RAM-only and disappear at shutdown. Enterprise policy can pin
approved model ids and hashes, block provider-backed models, or redirect all
model downloads to an internal mirror.

## OS and Base Updates

Base OS updates are different because the root filesystem is a signed live
image. The production path has two tiers:

- **Safe v1 path:** signed full ISO plus guarded writer/refresh flow.
- **Better v1.x path:** signed OS delta or Tails-style incremental update
  kit for safe base changes, with full ISO fallback for major or unsafe
  changes.

The updater must always verify:

- current OS version, architecture, channel, and update ring
- signed update manifest and revocation metadata
- image, delta, or update-kit signature
- base version compatibility for deltas
- enough free space in persistence or target USB
- Persistent Storage migration plan and rollback behavior
- recovery path to either the current bootable USB, previous active runtime,
  or a fresh signed full ISO

Users should need a new full ISO only for first install, major base-OS
upgrades, failed delta fallback, emergency recovery, or intentionally
creating a fresh USB.

## Enterprise Mirrors and Policy

Enterprise support is not just a private download URL. A managed deployment
needs:

- mirrorable artifact layout for ISO, OS deltas, app/runtime bundles, model
  files, manifests, SBOMs, signatures, and release notes
- pinned trust roots and optional enterprise signing or countersigning
- policy bundle that sets channel, mirror URL, approved versions, model
  allowlist, provider allowlist, update deferral, and emergency rollback pin
- mirror freshness checks and explicit stale-mirror behavior
- offline update workflow for air-gapped or intermittently connected fleets
- fleet evidence records containing device class, channel, artifact hashes,
  update result, and failure reason without recording user secrets
- recovery and deprovisioning guidance for lost USBs, broken updates,
  forgotten persistence passphrases, and retired devices

Enterprise policy can approve downloads without a per-user prompt, but it
must not bypass signature/hash verification. Policy chooses what is allowed;
the verifier still proves what is being run.

## Recovery and Rollback

Recovery is a product feature, not an afterthought.

Required recovery paths:

- app/runtime rollback to previous persistent runtime
- app/runtime fallback to the baked ISO runtime
- model rollback or deletion when a model is revoked, corrupt, too large, or
  incompatible with the current runtime
- OS update fallback to signed full ISO when delta application fails
- USB writer recovery for interrupted writes or post-write verification
  failure
- Persistent Storage migration failure handling that preserves old data until
  the migration is verified

Rollback must be tested across channel changes, not only same-channel
updates. Enterprise rollback can be a policy pin to a known-good app/runtime,
model catalog, or OS image.

## Signing and Provenance

Production signing is still missing. Before beta/stable can be honest, the
project needs:

- offline or hardware-backed root keys
- separate online signing keys for nightly/beta/stable as appropriate
- release approval records before production signing
- revocation metadata served with every manifest
- signed checksums for ISO and update artifacts
- signed manifests for app/runtime bundles, model catalog entries, OS
  deltas, policy bundles, and mirror metadata
- provenance attestation tying artifact hashes to source revision, builder
  image, dependency snapshot, CI run, and signing event
- documented emergency key rotation and compromised-artifact response

Until this exists, builds are test artifacts even if the ISO boots.

## Built-In USB Writer

The developer script already does the right kind of device checks: it accepts a
specific target device, verifies that it is removable, refuses mounted targets,
and writes the raw USB image. It now refuses direct ISO writes by default
because Tails Persistent Storage expects the USB-image layout, not a CD-ROM ISO
layout. The desktop app should reuse that same policy before offering a GUI
writer:

- show only removable drives
- display size, model, serial, and current mounts
- require destructive confirmation with the exact device name
- refuse the boot device unless explicitly doing a supported clone/update
  flow
- write, sync, verify checksum, and show the result

Balena Etcher remains acceptable as a documented fallback, but the product
should not depend on it. The production flasher should be signed:

- macOS: signed/notarized package, Disk Arbitration or `diskutil`, raw
  device writes, explicit authorization prompt
- Windows: signed installer, physical-drive enumeration, lock/dismount
  target volumes, clear warning about post-write format prompts
- Linux: AppImage or archive plus CLI, `lsblk --json` enumeration, polkit
  or root only for the write step

The release artifact set must include a persistence-compatible `.img` USB
image. The visible filesystem label can be `ELIZAOS`, but the internal GPT
system partition name must stay `Tails` unless all inherited Tails persistence
and IUK checks are changed together.

## Demo Debt

These are explicit demo debts, not production claims:

- no production release keys or key custody process
- no production update keyring or signing ceremony; only a development
  signing helper exists
- no downloader/revocation service for app/runtime updates
- prototype signed manifest verifier exists, but it still needs release-key
  infrastructure and real Persistent Storage integration tests
- model catalog schema/validator exists, but no signed model downloader
- no enterprise mirror layout or policy bundle
- no tested OS delta/update-kit path
- no GUI flasher
- release evidence generator exists, but no full automated
  SBOM/license/provenance gate
- no tested rollback or recovery flow
- no hardware compatibility matrix for stable release
- no completed security review for capability broker, sudoers, polkit,
  AppArmor, updater, or model download paths

## Demo Positioning

For the current demo, the correct statement is:

> This is an elizaOS Live USB prototype that preserves the underlying
> live-OS security model, boots into an elizaOS-branded experience, and
> bundles a fallback elizaOS app/runtime in the ISO. Production fast-update
> architecture now has a checked foundation: a boot-time verifier can validate
> signed app/runtime manifests and materialize verified runtimes into a
> root-owned store, while falling back to the baked ISO runtime if trust is
> missing. Production release keys, downloader UX, revocation, signed model
> catalog/downloads, OS delta/full-image update flows, enterprise
> mirrors/policy, and rollback infrastructure are still release work.
