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
