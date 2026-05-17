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
| Updates | Rebuild ISO for OS/base changes | Signed app/model updates plus signed OS delta or full-image updater |
| USB flasher | Guarded developer script | Signed GUI + CLI for macOS, Windows, Linux with the same disk-safety policy |
| Enterprise controls | Planning docs only | Signed manifests, rings, policy pins, mirrors, rollback, and non-secret audit evidence |

None of these should be hidden. They should stay explicit in docs and
checks until replaced.

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
