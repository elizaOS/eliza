# Current elizaOS Live Status

Last updated: 2026-05-17.

This branch is a working demo/productization branch, not a finished
enterprise release.

## Proven Evidence

- A prior full elizaOS Live ISO was built, booted in QEMU, flashed to a
  removable SanDisk USB device with the guarded writer, and verified by
  readback. That earlier tested hash was:

```text
6419dbee227317983ff2c6d02c3fd4bf97c6699ac1d26f0c98476f2ba58cfc10
```

- The current HEAD source has now been rebuilt into a fresh canonical ISO at
  `tails/binary.iso` / `out/binary.iso`. Do not use older named ISO copies in
  `out/` for validation; they can be stale.

```text
2ff679a74464dd1ad37c0202b58fc56c5dd64b6e9ce047945d6ee60fcb139faa
```

- Normal QEMU boot of that exact current-HEAD artifact reached the elizaOS
  greeter, started a normal GNOME desktop, and showed the elizaOS app window
  on the desktop.

## Current HEAD Caveat

Current HEAD has QEMU visual evidence for boot, greeter, desktop, and app
window startup. It has not yet been flashed/readback-tested to USB, booted on
real hardware, or validated for real USB Persistent Storage create/unlock/delete
behavior.

## Fixed Tonight

The latest boot blocker was not branding or the app runtime. Debug boots showed
that the live root filesystem could be left mode `0700`, preventing non-root
system services from traversing `/` and causing D-Bus, polkit, GDM, and
Persistent Storage startup failures.

The current artifact contains the fix:

- `run-nosymfollow.mount.d/elizaos-root-mode.conf` documents the intended
  `0755` directory mode for the inherited nosymfollow bind mount.
- `elizaos-root-mode.service` runs after `run-nosymfollow.mount` and
  `systemd-tmpfiles-setup.service`, then restores `/` plus
  `/run/nosymfollow` to `0755`.
- The earlier D-Bus and polkit working-directory drop-ins were removed because
  they were symptom workarounds, not the root cause.
- `milady.path` no longer participates in an ordering cycle with
  `elizaos-update-verify.service`; the path unit can arm normally while
  `milady.service` waits for verifier setup.

## Tonight Validation Plan

Completed so far:

1. Synced the root-mode and ordering-cycle fixes into the existing build
   chroot.
2. Repacked the fixed chroot into a fresh `tails/binary.iso`.
3. Pointed `out/binary.iso` at that exact artifact.
4. Verified the built squashfs contains the root-mode drop-in,
   `elizaos-root-mode.service`, update verifier, and health-check fixes.
5. Booted the exact artifact in QEMU and visually confirmed greeter, desktop,
   and app window startup.

Still required before claiming a final USB demo:

1. Repeat guarded USB flash/readback for the `2ff679a7...` artifact.
2. Boot that USB on real hardware.
3. Validate real USB Persistent Storage create/unlock/delete behavior.
4. Validate privacy/direct networking behavior for the app, renderer, and any
   external web/OAuth surfaces.

Product ideas and production hardening are tracked in
[`production-readiness.md`](./production-readiness.md) and
[`distribution-and-updates.md`](./distribution-and-updates.md); they should not
delay tonight's demo proof unless they affect boot, app launch, persistence,
privacy, or USB safety.

## Latest Source Audit Addendum

The latest source audit does not add a new blocker for tonight's QEMU proof,
but it does set the honest product boundary:

- Clean source checkouts do not contain the generated staged app payload.
  Build or CI must run `just milady-app` before a full ISO build.
- The current baked runtime is good demo substrate, but the long-term
  production package should be a deterministic signed app/runtime artifact
  rather than a huge copied development tree.
- The signed app/runtime updater foundation exists, but production still
  needs downloader UX, revocation metadata, a production keyring, rollback
  health policy, and no-follow/root-owned update materialization hardening.
- Privacy Mode is not production-claimable for embedded browser, WebView,
  OAuth, or arbitrary external web surfaces until explicit proxy behavior is
  proven.
- Residual visible Tails help/support/update links remain in lower-frequency
  surfaces such as Tor Connection Assistant, USB Cloner help, WhisperBack,
  low-RAM/UEFI/error notifications, and inherited updater/security messages.
  Internal Tails module names and paths should stay unless doing a deeper
  upstream fork.
- Phase 9 customization actions must use the capability broker and approval
  policy. Passwordless `apt-get`, broad sudoers, or free-form root shell
  actions are rejected for this product.

## Product Architecture Notes

The intended product claim is **elizaOS Live: a Tails-derived live USB Linux
distribution with the elizaOS app/runtime as the home AI surface**. The normal
desktop stays available, and Tails internals stay intact where renaming would
break upstream contracts.

The app is already baked into the ISO as a factory fallback. The production
path is not to give the app unrestricted root; it is to keep the app/UI under
the `amnesia` user, keep root-owned supervision and launch policy in systemd,
and expose privileged actions through a named capability broker with approval,
argument allowlists, and audit evidence.

Fast Milady/eliza app updates should not require a full ISO every time. The
right architecture is signed app/runtime bundles in encrypted Persistent
Storage, verified into a root-owned runtime store, with rollback to the baked
factory runtime. Base OS updates remain separate: signed full ISO first, then
signed OS deltas or a Tails-style incremental update path once release
infrastructure exists.

Large models should not be baked into every USB by default. The ISO should
ship runtime support plus a signed model catalog. Onboarding can offer cloud
sign-in, local-only mode, signed Eliza-1/local model download, or enterprise
managed mirrors. Downloaded models belong in encrypted Persistent Storage; in
amnesia mode they must disappear at shutdown.

The clean production gates remain: deterministic signed app artifacts, no
hidden dev workspace resolution, release keyring and revocation metadata,
SBOM/license/provenance, formal sudoers/capability-broker review, privacy
proof for embedded browser/OAuth paths, and real USB persistence validation.

## Still Pending

- Repeat guarded USB flash/readback for the current `2ff679a7...` artifact.
- Boot the USB on real hardware.
- Validate real USB Persistent Storage create/unlock/delete behavior.
- Validate privacy/direct networking behavior for the app, renderer, and any
  external web/OAuth surfaces.
- Run release-mode security gates once production keyring, SBOM, provenance,
  and signed update artifacts exist.

## Production Blockers

- Production update keyring, revocation metadata, SBOM, and provenance
  artifacts are still missing.
- Privacy Mode is not production-claimable for embedded browser/OAuth/external
  web content until proxy injection is proven.
- The runtime packaging still carries demo glue: a large baked app tree,
  generated optional-plugin stubs, live embedding fallback, and compatibility
  workarounds.
- The signed app/runtime updater foundation exists, but the downloader,
  production promotion service, and rollback health policy are not complete.
