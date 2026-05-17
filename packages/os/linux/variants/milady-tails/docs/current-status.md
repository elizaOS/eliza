# Current elizaOS Live Status

Last updated: 2026-05-17.

This branch is a working demo/productization branch, not a finished
enterprise release.

## Proven Evidence

- A full elizaOS Live ISO was built and booted in QEMU.
- QEMU evidence showed the branded greeter/desktop path and the elizaOS app
  services active in the live session.
- The guarded USB writer flashed that tested ISO to a removable SanDisk USB
  device and verified the written bytes against the ISO.

The validated ISO hash was:

```text
6419dbee227317983ff2c6d02c3fd4bf97c6699ac1d26f0c98476f2ba58cfc10
```

## Current HEAD Caveat

After that successful QEMU/USB readback pass, the branch received additional
source-only branding polish: official SVG icons, Persistent Storage icon
replacement, EFI boot icon replacement, inherited visible-string cleanup, and
docs updates.

Those changes are correct in source and covered by smoke checks, but they are
not on the already-flashed USB until a fresh ISO is rebuilt and flashed again.

## 2026-05-17 Rebuild Attempt

A fresh full build completed with the current app/runtime and branding work:

```text
out/tails-amd64-stable@0fa159b265-20260517T0928Z.iso
sha256 46f75de4f91a751a6b22f310edce119d755153580db3df04d6ee8741136e474e
```

The ISO metadata is valid and identifies itself as elizaOS, but the normal
BIOS QEMU boot stayed at a black cursor. A direct kernel/initrd debug boot
reached systemd and serial login, which means the root filesystem can start,
but the graphical greeter/session was blocked by boot-time service failures.

The concrete failures found in serial logs were:

- `dbus.service` exited with `status=200/CHDIR`, preventing the normal
  D-Bus/GDM graphical path from starting.
- `elizaos-update-verify.service` failed systemd mount namespacing when
  `/live/persistence/TailsData_unlocked/elizaos-system` did not exist yet,
  which is the expected state before Persistent Storage is enabled.

Source fixes are now staged and covered by smoke checks:

- `dbus.service.d/elizaos-working-directory.conf` creates `/run/dbus` with
  `RuntimeDirectory=dbus` and starts D-Bus from `WorkingDirectory=/run/dbus`.
- `polkit.service.d/elizaos-working-directory.conf` pins polkit to
  `WorkingDirectory=/` so it cannot inherit an invalid working directory.
- The update verifier and health checker use systemd's `-` optional path
  prefix for the Persistent Storage update store, so the services do not fail
  just because persistence has not been created.

The `46f75de4...` ISO does not contain those fixes. The current HEAD source
and build chroot both contain them. The next artifact must be an incremental
repack from the fixed source/chroot, followed by another QEMU normal-boot
proof.

## Latest Debug Notes

The latest binary-only repack produced a fresh canonical artifact at
`tails/binary.iso` and `out/binary.iso` with hash:

```text
31170d32ff6a242d36db3eac276584554df312aa98f6543013f64b844684eca5
```

Do not use the older named ISO copy in `out/` for validation; it can be stale.

That fresh artifact contains the D-Bus, polkit, and update-service drop-ins,
but normal QEMU graphical boot still did not reach the greeter. A direct
kernel/initrd debug boot showed:

- `elizaos-update-verify.service` is fixed and no longer blocks boot before
  Persistent Storage exists.
- `dbus.service` still exits with `status=200/CHDIR` when started by systemd.
- `polkit.service` also exits with `status=200/CHDIR` when started by systemd.
- `gdm.service` later fails its `generate-config` pre-start step with
  `status=127`, so the graphical greeter cannot be trusted yet.

An interactive systemd debug shell found the underlying cause: the live root
filesystem was mode `0700`, so non-root system services could not traverse `/`
or load shared libraries. Manually running `chmod 0755 /` inside the VM
immediately allowed D-Bus, polkit, and GDM's `generate-config` to start.

Source fixes are now staged:

- `run-nosymfollow.mount.d/elizaos-root-mode.conf` sets the inherited
  nosymfollow bind-mount directory mode to `0755`, preventing the bind mount
  setup from leaving `/` inaccessible to non-root services.
- The temporary D-Bus and polkit working-directory drop-ins were removed; they
  were treating symptoms, not the root cause.
- `milady.path` no longer participates in an ordering cycle with
  `elizaos-update-verify.service`; the path unit can arm normally while
  `milady.service` itself waits for the verifier.

The next artifact must be rebuilt from these fixes before another normal QEMU
demo attempt.

## Tonight Validation Plan

The fast path to a credible demo is:

1. Sync the root-mode and ordering-cycle fixes into the existing build
   chroot.
2. Repack the current fixed chroot into a fresh `tails/binary.iso`.
3. Treat `tails/binary.iso` as the canonical fresh artifact, because older
   named ISO copies in `out/` can be stale.
4. Point `out/binary.iso` at that exact artifact for test scripts.
5. Verify the built squashfs contains the root-mode drop-in, removed D-Bus
   and polkit workaround drop-ins, update verifier, and health-check fixes.
6. Boot the exact artifact in QEMU.
7. If normal graphical boot fails, use the built-in direct-kernel debug boot
   to collect serial logs before changing code.
8. Only flash USB after QEMU proves the rebuilt artifact reaches the intended
   elizaOS greeter/session/app path.

The only easy wins before spending more build/test time are source-level:
keep this document current, keep the PR/share branches synchronized, and
make smoke checks guard the exact root-mode/startup-ordering regression that
blocked the last artifact. Product ideas and production hardening are tracked
in [`production-readiness.md`](./production-readiness.md) and
[`distribution-and-updates.md`](./distribution-and-updates.md); they should
not delay tonight's demo proof unless they affect boot, app launch,
persistence, privacy, or USB safety.

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

- Rebuild the current HEAD ISO.
- Run QEMU on that exact rebuilt artifact.
- Repeat guarded USB flash/readback for that exact artifact.
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
