# Current elizaOS Live Status

Last updated: 2026-05-20.

This branch is a working demo/productization branch, not a finished
enterprise release.

## Latest Validated Artifact

The latest local ISO previously validated from this branch was:

```text
out/binary.iso
sha256 3a26c4990a5dcc53c4a5f3dcf3e6c400a0df5a06aeb6cf37c5fb03c210dfb9f2
size   3.3G
```

ISO metadata:

- volume: `ELIZAOS 7.8 - 20260504`
- publisher: `HTTPS://ELIZAOS.AI/`
- application: `ELIZAOS`

Rebuild and revalidate if the source branch moves. Older named ISO copies in
`out/` can be stale and should not be treated as release evidence.

The source branch has moved since that artifact. The current HEAD has additional
USB/persistence and onboarding fixes and needs a fresh ISO/USB-image rebuild
before the artifact hash above can be used as release evidence.

## Proven In QEMU

The exact artifact above was booted normally with KVM/QEMU from `out/binary.iso`
and visually validated:

1. elizaOS greeter appears.
2. Greeter uses the light elizaOS blue/white/Poppins branding.
3. `Start elizaOS` starts a normal GNOME live desktop.
4. GNOME top bar and window list are light/white instead of inherited black.
5. The elizaOS app auto-launches as the normal live user.
6. The app onboarding screen renders in the clean elizaOS white/blue theme.
7. Closing the app window minimizes it to the window list instead of exposing
   the old broken voice-pill loading surface.

Built-squashfs checks also confirmed:

- the renderer HTML contains the elizaOS live theme override
- packaged renderer CSS has no old orange palette tokens
- `color-scheme='prefer-light'` and Poppins defaults are inside the image
- the white/blue GNOME window-list stylesheet is inside the image
- `elizaos-pill.service` remains installed but is not auto-enabled until the
  pill renderer is production-ready

## 2026-05-20 Virtual USB Proof

A disposable raw USB image in `/tmp` was booted in QEMU as a USB mass-storage
device. This is not a physical USB proof, but it exercises the same live USB
boot-device shape without touching laptop disks.

Passed:

1. UEFI boot from virtual USB reached the elizaOS boot splash.
2. The normal Tails greeter path rendered as elizaOS.
3. The live session started a GNOME desktop from the greeter.
4. The elizaOS app auto-started as the `amnesia` user.
5. `milady.service` was active.
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
11. The elizaOS/Milady Persistent Storage feature activated and bind-mounted
    the expected app state paths from encrypted storage, including `~/.eliza`,
    `~/.config/elizaOS`, and `~/.cache/ai.elizaos.app`.

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

The final persistence-enabled desktop/app reboot was not counted as passed on
the stale VM image because that image did not include the new `sudo` package
fix. It reached the branded GDM background with encrypted storage unlocked, but
the greeter dialog crashed while running inherited Persistent Storage hooks.

Not yet re-proven on a rebuilt final image:

- The patched voice onboarding flow inside a freshly rebuilt ISO/USB image.
- The persistence-enabled greeter/desktop/app path with the new `sudo` package
  fix inside the image.
- Full physical USB flash + hardware boot.
- Persistence unlock across reboot on physical USB hardware.

## Earlier Hardware Evidence

A prior elizaOS Live artifact was flashed to a removable SanDisk USB device
with the guarded writer and verified by readback:

```text
6419dbee227317983ff2c6d02c3fd4bf97c6699ac1d26f0c98476f2ba58cfc10
```

That earlier USB proof does not automatically validate the latest
`3a26c499...` artifact. Repeat guarded USB flash/readback before presenting the
current ISO as a hardware-tested demo.

## Current Product Shape

elizaOS Live is a Tails-derived live USB Linux distribution. The normal desktop
and Tails live-OS plumbing remain intact, while the visible product surface is
elizaOS:

- elizaOS boot/greeter/desktop branding
- bundled elizaOS/Milady app runtime baked into the ISO as factory fallback
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

Still required before calling this a final USB demo:

1. Rebuild the ISO and USB `.img` from current HEAD.
2. Repeat guarded USB flash/readback for that exact `.img`.
3. Boot that USB on real hardware.
4. Validate real USB Persistent Storage create/unlock/delete behavior.
5. Validate privacy/direct networking behavior for the app, renderer, embedded
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
