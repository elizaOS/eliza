# Current elizaOS Live Status

Last updated: 2026-05-22.

This branch is a working demo/productization branch, not a finished
enterprise release.

## Latest Validated Artifact

The latest local ISO validated from this branch was:

```text
out/binary.iso
sha256 0738eaf5291263de43d5c7cb326ca69bc011bcbd8ddefafe03e023db6310ced9
size   3.3G
```

The corresponding persistence-compatible USB disk image was:

```text
out/binary.img
sha256 ff9f5dc15729164bb115ae73cc4d2d75e43f0b45596227149469971300ce123c
size   12G
```

ISO metadata:

- volume: `ELIZAOS 7.8 - 20260504`
- publisher: `HTTPS://ELIZAOS.AI/`
- application: `ELIZAOS`

Rebuild and revalidate if the source branch moves. Older named ISO copies in
`out/` can be stale and should not be treated as release evidence.

## Proven In QEMU

The exact ISO and USB image above were booted normally with KVM/QEMU and
visually validated:

1. elizaOS greeter appears.
2. Greeter uses the light elizaOS blue/white/Poppins branding.
3. `Start elizaOS` starts a normal GNOME live desktop.
4. GNOME top bar and window list are light/white instead of inherited black.
5. The elizaOS app auto-launches as the normal live user.
6. The app onboarding screen renders in the clean elizaOS white/blue theme.
7. Closing the app window minimizes it to the window list instead of exposing
   the old broken voice-pill loading surface or disappearing from GNOME.
8. Clicking the `[elizaOS]` task-list entry restores the app.
9. Persistent Storage can be created from the final writable USB image:
   matching passphrases enable the Create button, creation completes, and the
   feature-toggle view reports that Persistent Storage is unlocked.

Built-squashfs checks also confirmed:

- the renderer HTML contains the elizaOS live theme override
- packaged renderer CSS has no old orange palette tokens
- `color-scheme='prefer-light'` and Poppins defaults are inside the image
- the white/blue GNOME window-list stylesheet is inside the image
- `elizaos-pill.service` remains installed but is not auto-enabled until the
  pill renderer is production-ready
- the packaged Electrobun runtime contains the close-minimizes behavior
- the packaged app runtime reaches API readiness in the local runtime smoke
  check

## 2026-05-22 Virtual USB Proof

`out/binary.img` was booted in QEMU as a USB mass-storage device through a
qcow2 overlay. This is not a physical USB proof, but it exercises the same
partition and boot-device shape without touching laptop disks.

Passed:

1. USB image creation used the guarded Tails image path, not a raw ISO write.
2. FAT filesystem label is `ELIZAOS`.
3. `syslinux/ldlinux.sys` is present.
4. The backup GPT header was moved to the end of the expanded 12G image.
5. `sgdisk --verify out/binary.img` reported no problems.
6. `sha256sum -c out/SHA256SUMS` passed for both ISO and USB image.
7. QEMU boot from the virtual USB image reached the elizaOS greeter.
8. The session reached the normal GNOME desktop and auto-started the elizaOS
   app.
9. App close/minimize/restore passed visually.
10. Persistent Storage creation passed visually and reached the unlocked
    feature-toggle screen.

Remaining non-VM validation:

- write `out/binary.img` to a physical removable USB stick with the guarded
  writer or an equivalent image writer
- boot that physical stick on real hardware
- create, unlock, reboot, and re-unlock Persistent Storage on the physical
  stick
- validate privacy/direct networking behavior for the exact release artifact

## 2026-05-20 Historical Virtual USB Proof

A disposable raw USB image in `/tmp` was booted in QEMU as a USB mass-storage
device. This is not a physical USB proof, but it exercises the same live USB
boot-device shape without touching laptop disks.

Passed:

1. UEFI boot from virtual USB reached the elizaOS boot splash.
2. The normal Tails greeter path rendered as elizaOS.
3. The live session started a GNOME desktop from the greeter.
4. The elizaOS app auto-started as the `amnesia` user.
5. `elizaos.service` was active.
6. The local renderer/API were listening on `127.0.0.1:5174` and
   `127.0.0.1:31337`.
7. `/api/health` returned `ready:true`, `runtime:"ok"`,
   `database:"ok"`, and `plugins.failed:0`.
8. After correcting the internal GPT partition name to upstream-compatible
   `Tails` while keeping the visible FAT label `ELIZAOS`, the Tails
   persistence eligibility guard exited `0`.
9. The Tails Persistent Storage D-Bus API created and unlocked a LUKS
   `TailsData` partition on the virtual USB image.
10. Rebooting the same virtual USB image preserved the `TailsData` partition,
    reported `CanUnlock=true`, and unlocked with the original passphrase.
11. The elizaOS/elizaOS Persistent Storage feature activated and bind-mounted
    the expected app state paths from encrypted storage, including `~/.eliza`,
    `~/.config/elizaOS`, and `~/.cache/org.elizaos.app`.

Issues found and fixed in source after this proof:

- Voice onboarding step 5 crashed when the voice-profile endpoint returned a
  partial capture session without prompts. The client now normalizes partial or
  malformed sessions and falls back to built-in prompts; the UI also guards
  prompt indexing.
- USB image creation now keeps the internal GPT system partition name `Tails`
  for Tails persistence/IUK compatibility while retaining the visible
  `ELIZAOS` filesystem label.
- The guarded USB writer now prefers `.img` USB images and refuses direct ISO
  writes by default because direct ISO writes are not persistence-compatible.
- `sudo` is explicitly included because inherited Persistent Storage hooks call
  it during activation/deactivation.

That historical proof found issues that were fixed before the 2026-05-22
artifact above. The stale 2026-05-20 image should not be used as release
evidence.

## Earlier Hardware Evidence

A prior elizaOS Live artifact was flashed to a removable SanDisk USB device
with the guarded writer and verified by readback:

```text
6419dbee227317983ff2c6d02c3fd4bf97c6699ac1d26f0c98476f2ba58cfc10
```

That earlier USB proof does not automatically validate the latest
`0738eaf...` artifact. Repeat guarded USB flash/readback before presenting the
current ISO as a hardware-tested demo.

## Current Product Shape

elizaOS Live is a Tails-derived live USB Linux distribution. The normal desktop
and Tails live-OS plumbing remain intact, while the visible product surface is
elizaOS:

- elizaOS boot/greeter/desktop branding
- bundled elizaOS/elizaOS app runtime baked into the ISO as factory fallback
- app/renderer/agent run as the `amnesia` live user
- root is reserved for supervision and narrow capability-broker actions
- encrypted Persistent Storage is the durability path for user state, models,
  credentials, and future app/runtime updates

The production model is **not** unrestricted app root. The production model is a
supervised user app plus explicit brokered root capabilities with allowlists,
approval policy, and audit evidence.

## Current Demo Boundary

Good enough to demo in QEMU:

- boot to elizaOS greeter
- start a normal live desktop
- see elizaOS app auto-launch
- inspect the light branded shell/app surface
- close/minimize the app without the broken pill loader
- create Persistent Storage on a virtual USB image

Still required before calling this a hardware-validated USB demo:

1. Repeat guarded USB flash/readback for the exact `out/binary.img`.
2. Boot that USB on real hardware.
3. Validate real USB Persistent Storage create/unlock/delete/reboot behavior.
4. Validate privacy/direct networking behavior for the app, renderer, embedded
   browser, OAuth, and any external web surfaces.

## Production Blockers

These are tracked in the production docs and should stay visible:

- production update keyring, revocation metadata, downloader UX, rollback
  health policy, SBOM, and provenance artifacts are still missing
- Privacy Mode is not production-claimable for embedded browser/OAuth/external
  web content until proxy behavior is proven
- runtime packaging still carries demo glue: a large baked app tree, generated
  optional-plugin stubs, live embedding fallback, and compatibility workarounds
- the voice pill service is installed but opt-in until the pill renderer has a
  production UI
- inherited Tails sudoers remain accepted as upstream plumbing and still need
  formal external review for an enterprise release

Product direction and update architecture are tracked in
[`production-readiness.md`](./production-readiness.md),
[`distribution-and-updates.md`](./distribution-and-updates.md), and
[`security-model.md`](./security-model.md).
