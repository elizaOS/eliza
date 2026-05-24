# Production Readiness

This document is deliberately blunt. elizaOS Live is a real live-OS
integration, but the current branch is still a demo/productization branch,
not a final enterprise release.

Product positioning: elizaOS Live is a USB-bootable distro built on
Tails live-OS plumbing. The primary user experience should be elizaOS
Live, not a visibly rebranded Tails session. Tails remains credited in
license/about materials and preserved in engineering internals where
renaming would break upstream contracts.

## Clean and Standard

These parts are aligned with normal Tails/live-build practice:

- Tails source stays intact under the active variant.
- elizaOS changes are added through live-build overlays, chroot hooks,
  package lists, and replacement assets.
- The build runs in a container instead of relying on a host-specific
  Vagrant/libvirt setup.
- The app starts through systemd and the normal `amnesia` live user rather
  than replacing the whole desktop stack.
- Root is reserved for narrow supervised OS capabilities; normal app/UI
  work runs as the live user.
- Static smoke checks cover high-risk integration mistakes.
- Security smoke checks cover the current broker, sudoers, persistence,
  systemd, update-marker, SBOM, and provenance policy.
- The USB writer uses removable-disk guard rails instead of blindly
  running `dd`.

## Demo Glue and Technical Debt

These parts are acceptable for a working demo but need hardening before a
production release:

| Area | Current Shape | Production Direction |
|---|---|---|
| App payload | Large bundled Electrobun runtime tree staged into the live image | Slim signed app bundle with deterministic packaging and rollback |
| Runtime packages | Many copied runtime packages and generated optional-plugin stubs | First-class production dependency graph; no hidden dev workspace resolution |
| CEF profile/sandbox | Tails-specific profile layout and sandbox fallbacks | Upstreamable Electrobun/CEF fix; explicit renderer sandbox decision |
| Model boot | Fallbacks prevent startup from requiring a private model download | Signed model catalog; onboarding-driven download/provider choice |
| Privileged actions | Conservative capability runner, mostly status/root-status | Approval-gated policy, audit log, AppArmor/polkit review |
| Branding | Direct Tails UI/string overrides where needed | Stable brand overlay package; keep required Tails internals untouched |
| Updates | Baked runtime plus checked signed-runtime verifier foundation; rebuild ISO for OS/base changes | Production keys, downloader, revocation, signed app/model updates, plus signed OS delta or full-image updater |
| USB flasher | Guarded developer script | Signed GUI + CLI for macOS, Windows, Linux with the same disk-safety policy |
| Enterprise controls | Planning docs only | Signed manifests, rings, policy pins, mirrors, rollback, and non-secret audit evidence |

None of these should be hidden. They should stay explicit in docs and
checks until replaced.

## Current Audit Findings

The latest source audit found no new elizaOS-owned broad sudo rule beyond
the checked `root-status` path, but it did find production blockers that
must stay visible:

- clean checkouts do not contain the staged app payload; a build must run
  `just elizaos-app` before a full ISO build
- app/runtime update materialization now verifies a complete signed file
  inventory, rejects symlinks, re-hashes files while copying, and selects
  only a root-owned materialized runtime store; production still needs real
  release keys, downloader UX, revocation metadata, and rollback tests
- update promotion health checks currently rely on unauthenticated local
  loopback probes and need a stronger promotion token or root-owned state
  handoff
- Privacy Mode is not production-claimable for embedded browser/OAuth or
  arbitrary external web surfaces until explicit proxy behavior is proven
- production update keyring, SBOM, and provenance artifacts are still
  release blockers in strict security smoke
- generated optional-plugin stubs and live embedding fallback are demo
  compatibility glue, not final production packaging
- common inherited help/support/update surfaces are routed to elizaOS
  docs/support or gated until elizaOS infrastructure exists. Internal Tails
  module names, service users, labels such as `TailsData`, and audited
  updater plumbing remain where renaming would break the live-OS stack.
- Phase 9's earlier passwordless apt/sudoers direction is superseded by the
  capability-broker security model. Privileged package, service, network,
  and device actions need exact broker schemas, user approval or enterprise
  policy, and audit events.

## AI OS Product Direction

It is accurate to describe elizaOS Live as a Tails-derived live USB Linux
distribution. The product ambition is larger: a portable agentic AI OS with
the elizaOS app as the home surface and the normal Linux desktop still
available underneath.

The current branch already has the right foundation for the demo:

- branded live USB boot, greeter, wallpaper, and desktop identity
- bundled elizaOS app/runtime baked into the image as the factory fallback
- root-owned supervision with normal app/UI work running as `amnesia`
- narrow capability broker instead of broad app root
- Tails-native encrypted Persistent Storage integration
- guarded USB writer and readback verification
- signed app/runtime update architecture foundation
- model/update/security/release docs and smoke checks

The production product should add these first:

- **Trust cockpit:** one place showing storage mode, Privacy Mode, model
  route, network route, app/runtime version, update status, and permissions.
- **Permissioned root actions:** package, network, service, device, and
  recovery operations through the broker only, with user approval or
  enterprise policy and audit events.
- **Signed model catalog:** onboarding can choose cloud sign-in, local-only
  mode, or a signed Eliza-1/local model download with hashes, license,
  hardware requirements, and mirror policy.
- **Fast app/runtime updates:** signed bundles stored in encrypted
  persistence, verified and materialized into a root-owned runtime store,
  with rollback to the baked `/opt/elizaos` factory runtime.
- **AI development packs:** optional signed packs for PyTorch, CUDA/ROCm,
  compilers, notebooks, and heavier ML tooling. Do not bake PyTorch into the
  base image; it is too large and too hardware-specific for every USB.
- **Model-aware routing:** local/cloud/Tor/direct choice based on privacy
  mode, hardware, RAM, battery, model availability, and provider policy.
- **Sandboxed app builder:** generated apps run in constrained user
  sandboxes and never inherit root or secrets by default.
- **Enterprise controls:** update rings, mirrors, allowed-model policy,
  plugin allowlists, fleet evidence, recovery workflows, and deprovisioning.

Clear near-term wins before marketing this as a production AI OS:

1. Repeat guarded USB flash/readback for the current QEMU-tested ISO.
2. Boot the rebuilt ISO on real hardware.
3. Prove Persistent Storage create/unlock/delete on a real USB.
4. Prove Privacy Mode behavior for agent, renderer, embedded browser, and
   OAuth surfaces.
5. Replace demo runtime staging with deterministic signed app artifacts.
6. Add a production promotion token or root-owned health handoff for signed
   app/runtime updates.
7. Generate and publish release SBOM, license bundle, provenance, checksums,
   signatures, and known-gaps notes.

## Checked Security Policy

The concrete policy lives in [`security-model.md`](./security-model.md).
Cheap validation lives in `scripts/security-smoke.sh`.

Default security smoke is a development gate:

```sh
scripts/security-smoke.sh
```

It fails on elizaOS-owned policy violations and warns on inherited Tails
exceptions or missing production infrastructure. Release candidates must run
strict mode:

```sh
ELIZAOS_SECURITY_STRICT=1 scripts/security-smoke.sh
```

Strict mode treats unexpected broad sudoers, missing production update keyring,
and missing SBOM/provenance artifacts as blockers. The inherited Tails broad
sudoers rules are explicitly reviewed in
[`inherited-tails-sudoers-review.md`](./inherited-tails-sudoers-review.md) and
must not grow silently. The USB writer has a signature-verification path, but
production still needs a real release keyring.

## Root Capability Boundary

The app should not "just have root." The correct product model is:

- app/UI runs as `amnesia`
- root-owned systemd supervises the app so it stays available
- privileged operations go through a small capability broker
- every broker operation has a named purpose, argument allowlist, and user
  approval or enterprise policy
- logs explain what happened without leaking secrets

Root access is powerful for an AI OS because it can manage system
packages, networking, services, persistence, devices, and recovery flows.
It is also the fastest way to break Tails' guarantees if unbounded. The
broker model is the release path.

Current checked policy:

- the only elizaOS-owned sudoers entry is
  `/usr/local/lib/elizaos/capability-runner root-status`
- `capability-runner` may expose status, privacy-mode status, the Persistent
  Storage launcher, and exact root-status smoke only
- package installation, service mutation, network mutation, disk writes, and
  arbitrary command execution are not broker capabilities

Known production finding: inherited Tails sudoers for Persistent Storage,
Greeter, Tor Browser, IUK updates, and WhisperBack contains broad internal
authority. elizaOS does not add to it; the current accept/mitigate decision is
documented in the inherited sudoers review. Enterprise release still needs an
external audit of that inherited trust boundary.

## Persistence and Update Boundaries

Current checked persistence policy:

- elizaOS Persistent Storage binds only `.eliza`, `.elizaos`,
  `.config/elizaOS`, legacy `.config/elizaos` names, and elizaOS CEF cache
  paths
- no elizaOS persistence binding may target all of `/home/amnesia`, `/etc`,
  `/usr`, `/var`, `/root`, `/opt`, or an unencrypted external path
- activation/deactivation must quiesce elizaOS user units before bind-mount
  changes
- runtime cache cleanup must stay under elizaOS-owned paths and use `find -P
  -xdev`

Current checked update policy:

- inherited Tails IUK signature-verification tests must remain present, but
  automatic base OS update checks are gated by
  `/etc/elizaos/base-updates-enabled` until elizaOS owns the feed, signing
  key, and release process
- app/runtime verifier requires a detached signature, complete file inventory,
  hash validation, and materialization into a root-owned runtime store before
  launcher selection
- runtime wrappers ignore caller-supplied runtime paths by default and fall
  back to the baked `/opt/elizaos` runtime when selector trust is missing
- development tooling can sign test manifests, validate model catalogs, and
  generate lightweight release evidence; production keys and full SBOM remain
  separate release gates
- docs must state signed app/runtime, signed model catalog, rollback, and
  fail-closed behavior
- production strict mode fails until release keys, SBOM, and provenance
  artifacts exist

## Definition of Demo-Complete

The demo is complete when the fresh ISO passes:

- boot menu and Plymouth show elizaOS
- greeter appears and can start a normal GNOME live session
- desktop remains usable with normal live-OS tools
- elizaOS app launches automatically as a normal window
- close button minimizes/restores or relaunches cleanly without feeling
  broken
- app service restarts the app after crash/exit
- amnesia mode wipes app state on reboot
- Persistent Storage preserves `~/.eliza`, app data, models, Wi-Fi, and
  credentials after unlock
- Privacy Mode routes agent/network traffic as documented
- no QEMU/build process is left running after tests

## Definition of Production-Grade

Production-grade requires the demo gates plus:

- real hardware USB validation across representative machines
- signed releases, checksums, SBOM, and license bundle
- security review of capability broker, sudoers, polkit, AppArmor, and
  update paths
- app/runtime package graph with no generated stubs for required features
- model/provider onboarding that works offline, online, and behind Tor
- update/rollback plan tested across releases
- accessibility, localization, and recovery flows
- threat model for amnesia, persistence, root capabilities, updates, and
  model downloads
- `ELIZAOS_SECURITY_STRICT=1 scripts/security-smoke.sh` passes

The branch should not be marketed as finished enterprise software before
those gates are complete.

## Enterprise Hardening Backlog

The enterprise backlog is not just packaging. Required work:

- signing key custody, release approval, revocation, and emergency
  rotation procedures
- separate update rings for nightly, beta, canary, pilot, broad, and
  emergency rollback
- signed manifests for ISO, OS deltas, app/runtime bundles, model catalog,
  and policy bundles
- internal mirror support with pinned trust roots
- capability-broker policy review, argument allowlists, and audit logging
- AppArmor, polkit, sudoers, systemd unit, and update-path review
- CVE, SBOM, license, and provenance gates before promotion
- persistent-storage migration tests across versions and rollback paths
- hardware compatibility matrix, including GPU, Wi-Fi, Secure Boot status,
  and problematic USB controllers
- recovery guide for broken updates, forgotten persistence passphrases,
  failed USB writes, and enterprise deprovisioning
