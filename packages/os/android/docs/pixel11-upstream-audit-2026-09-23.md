# Pixel 11 upstream recheck — September 23, 2026

The host tooling is ready for read-only device intake. A physical installation
is **not qualified**. This review preserves the source/firmware pins and disabled
eligibility; newer source code is not evidence that our image boots.

## GrapheneOS: corrections and changes since the pinned toolchain

The September 1 [official MTE update](https://bsky.app/profile/grapheneos.org/post/3mugn23cpx22l)
corrected the initial suspicion that Pixel 11 lacked hardware MTE entirely:
some hardware support exists, while firmware enablement and performance remain
questions. The [supported-device list](https://grapheneos.org/faq#supported-devices)
still does not list Pixel 11. Do not equate vendor generation with production
support, or use this security discussion as the cause of our boot failures.

On September 16, GrapheneOS [reported](https://bsky.app/profile/grapheneos.org/post/3mvnrhp3vfs26)
that its Android 17 QPR1 code could not yet be released and it was backporting
Pixel firmware, drivers and HALs instead. Such components need coordinated
provenance and functional testing.

The [adevtool comparison](https://github.com/GrapheneOS/adevtool/compare/144f004cc484d7e7234cdd167cee48e5f240288f...e091511f68f1c45ade2ae5d437a7563bc15442df)
contains 20 commits after our pin. Reviewed commit summaries and relevant
configuration contents, not only the unchanged grizzly-specific YAML:

| Upstream change | Consequence for this repository |
| --- | --- |
| September Pixel 11 image index (`5a1ee58779f6570cf35b550addfc8c8ef4db6527`) | Availability of a factory image does not authorize a downgrade or source/firmware substitution. |
| Split firmware backport options and modem backports (`345778abe1e0966b2a6831fa9f09baf6bc73a5b5`, `965f2c86f318649d67312e244d376052e04b37a9`) | Review effective inherited configuration before updating adevtool. |
| Require carrier settings with radio backports (`f9bca58f22f1f000bd09a881b25ce0114e8dca52`) | Radio firmware and Android carrier profiles must be qualified together. |
| Select the carrier source build and backport CarrierSettings (`83a5b47af3a52bac8f69930880e641fd5e683189`, `e68d54e8f68accc85b229b9b92f5d1076313bd02`) | Upstream diagnosed mismatched IMS media payload assignments and failed Wi-Fi calls. Our hardware matrix must check outgoing/incoming calling and DTMF as well as registration. |
| Validate carrier download origin (`c92cc4b418982a837deece175f13604ff1868731`) | Match the intended HTTPS origin, not a path substring, when qualifying future extraction tools. |

At latest inspected commit `e091511f68f1c45ade2ae5d437a7563bc15442df`,
[grizzly.yml](https://github.com/GrapheneOS/adevtool/blob/e091511f68f1c45ade2ae5d437a7563bc15442df/config/device/grizzly.yml)
still includes `common/gen11pixel.yml`, which includes `pixel.yml` and retains
`CD1A.260714.001.A9`. However,
[common/pixel.yml](https://github.com/GrapheneOS/adevtool/blob/e091511f68f1c45ade2ae5d437a7563bc15442df/config/device/common/pixel.yml)
now enables radio backports from `CP3A.260905.009`, carrier configuration and
`wfc-pkt-router`. Those settings were absent from our pinned common file.
**Inference:** bumping only adevtool could change grizzly's inherited inputs even
without a grizzly-file diff. Effective merge behavior, factory availability,
module outputs and matching carrier/radio versions must be checked on a real
regeneration before any upgrade; this review did not perform that regeneration.
The compare API file list can be truncated, so its file listing was not treated
as a complete audit of every changed binary.

The inspected vendor_state branch still ends at our pinned
`afd6a0c9f6ca13d395f00e98227a0866cc14de07`. No coordinated new grizzly baseline
was established by these upstream checks. Preserve the existing pins until
regeneration, exact-source builds, artifact inspection and physical testing
justify a single coherent update.

## LineageOS

Checked the official [wiki inventory](https://github.com/LineageOS/lineage_wiki/tree/1f4f944688ff75b3f9e13708e485f39a445b8cc4/_data/devices)
(740 entries) and [build targets](https://github.com/LineageOS/hudson/blob/5a29838ce6108a764b6d6809ce08e841baecbf08/lineage-build-targets).
Neither lists `cubs`, `grizzly`, `kodiak`, or `yogi`. The wiki's latest inspected
changes include additional device support and recovery-key instructions, but
provide no official Pixel 11 install procedure to adopt. This does not rule out
unofficial development; it does rule out treating a different Pixel's guide as
qualification for this phone.

## Unofficial development: expanded forum research

The official-support check above was insufficient to inventory working community
projects. Read all four pages of the [original Kodiak LineageOS thread](https://xdaforums.com/t/lineageos-for-pixel-11-pro-xl.4800740/),
including subsequent corrections, rather than treating the DroidWin article as
independent test evidence. Findings below are upstream reports, not tests of our
images. Checked September 23, 2026; forum posts and release assets can change.

### LineageOS 24 and DerpFest

The unofficial Kodiak guide uses matching recovery/boot images followed by an
ADB-sideloaded ROM ZIP. Its stock-firmware prerequisite still contains the
unresolved `<STOCK_FIRMWARE_VERSION>` placeholder. That procedure cannot become
our executable installation contract without resolving the exact prerequisite
and artifact set.

On [page 2](https://xdaforums.com/t/lineageos-for-pixel-11-pro-xl.4800740/page-2),
post 31 announces the September 11 networking fix; post 38 reports successful
installation and mobile data from stock `CD1A.260618.001.A7`. On
[page 3](https://xdaforums.com/t/lineageos-for-pixel-11-pro-xl.4800740/page-3),
posts 49–51 document a September 13 update and removal of built-in root.
Post 55 retracts a GApps-only explanation of camera failure and reports recovery
after a stock restore/reinstall. Posts 57–59 report working calls, Wi-Fi, data
and Android Auto. A commenter questions a missing `vendor_kernel_boot` in the
new upload: do not fill a missing artifact with one from another release.
On [page 4](https://xdaforums.com/t/lineageos-for-pixel-11-pro-xl.4800740/page-4),
DerpFest remains in testing. None of these reports qualifies a grizzly ROM.

The linked [Reeky kernel repository](https://github.com/Reeky-ux/lineage_kernel_google_kodiak)
provides concrete build leads: pinned ACK 6.12.92
(`d54332080871d28cfffbeaa65abc65902676c4a9`), corrected EdgeTPU source compilation
(`d0d7364acd608faee1b80ce355efa12fbabb8bdb`), and a WLAN macro collision fix
(`188b1a271525545f55579e6180b67f5673cd6186`). A kernel tree alone does not supply
the complete reproducible ROM device/vendor manifest; that remains unresolved.

### Recovery and kernel examples that include grizzly

The [OrangeFox thread](https://xdaforums.com/t/orangefox-r12-0-recovery-unofficial-cubs-grizzly-kodiak-yogi.4800982/)
has an actual grizzly decryption success report (post 8), followed by a QPR2
Beta 4 decryption failure (post 11) and a claimed upstream fix (post 13).
The author's own testing covers Fold; backup restoration remains untested.
The [release instructions](https://github.com/asdfmonster261/yogi-orangefox/releases/tag/R12.0-yogi-malibu)
distinguish the unassembled recovery input from a flashable image and preserve
the installed firmware's first-stage vendor boot content when assembling it.
Never treat the unassembled input as a ready image.

The thread warns that immediately after an OTA, bootconfig can still identify
the old slot until recovery restarts, causing subsequent AK3 installs to target
the wrong slot. This is a specific transition to cover in any recovery adapter.
The upstream [TWRP partition-unmapping fix](https://github.com/leegarchat/twrp_device_google_pixels/commit/1c90ad96c5e991f8aba0b134dd0ece28762819f1)
records repeated grizzly format failures from a device-mapper node absent from
logical-partition metadata. It adds a direct removal fallback while retaining
failure for busy nodes, and reports working PIN decryption with a zoned-keydir
fallback. These changes warrant source review and device tests, not an automatic
import into our installer.

The [Espada thread](https://xdaforums.com/t/kernel-pixel-11-11-pro-11-pro-xl-espada-kernel-cass-scheduler-simple-lmk-6-12-lts.4799975/)
and [v2 release](https://github.com/atrejokm301/espada-kernel/releases/tag/v2)
provide a more directly relevant grizzly kernel example. The maintainer reports
daily use on September `CD1A.260905.001.B1`, requires matching `boot` and
`vendor_kernel_boot`, separates root variants, and documents a firmware guard.
The release describes rebuilding September vendor drivers, including AOC and
its mailbox configuration. This is a candidate source baseline to investigate;
it is not evidence that our August image can accept September components.

### Failure reports relevant to host and device qualification

Google's [Android 17 QPR2 GSI notes](https://developer.android.com/about/versions/17/qpr2/gsi-release-notes)
explicitly list the Pixel 11 family among validated devices. The
[GSI release inventory](https://developer.android.com/topic/generic-system-image/releases)
publishes ARM64 images and SHA-256 digests. This supplies a possible independent
framework-testing control after checking the exact device prerequisites; it does
not validate our kernel, installer or firmware combination. Google labels these
developer images experimental and unsuitable for general use.

[KernelPatch issue 300](https://github.com/bmax121/KernelPatch/issues/300) reports
grizzly A9 boot failure despite a successful patch exit status. The reproduction
uses temporary boot; an earlier flashed attempt reportedly recovered by restoring
stock boot. Relocation/symbol resolution is the reporter's unverified hypothesis.
This does not establish the cause of our two incidents, but confirms that tool
success must never stand in for boot evidence.

[PixelFlasher issue 369](https://github.com/badabing2005/PixelFlasher/issues/369)
documents host memory exhaustion processing the large Kodiak factory archive.
The maintainer recommends its disk-backed processing option. Our artifact
preparation needs bounded memory, disk-space checks and complete extraction/hash
verification before entering any device-write phase.

### Follow-up qualification work

Implementation follow-up inspected the actual Espada v2 Magisk ZIP without
executing its scripts. Its SHA-256 matched GitHub's asset metadata:
`8d7e1701123060c5a0d6662d27eae020f94aa54db19e967a31d66af06f269cfa`.
The archive contains paired 64 MiB boot/vendor-kernel images. Its `anykernel.sh`
continues after failed backups, verifies vendor-kernel input only after writing
boot, and retains August/A9 comments despite the September release. Do not
adopt that script as our safe installer. Its AVB-footer/KeyMint explanation is
an important hypothesis to verify against actual image metadata and encrypted
hardware boot; it is not a diagnosis of our incidents.

Read-only inspection with the local AOSP `avbtool` found the boot image's AVB
properties identify Android 17, patch `2026-09-01`, B1 fingerprint and rollback
index `1788220800`. The vendor-kernel image also names B1 but has AVB algorithm
`NONE`; this does not independently establish its trust chain. The executable
AK3 setting `supported.patchlevels=- 2026-09` is an upper-bound range, not an
exact September firmware check: its parser uses `0000-00` as the lower bound.
Thus the downloaded script does not substantiate the release notes' assertion
that older firmware is refused. Preserve our exact bootloader/baseband checks.

The inspected `espada` source head was
`3e7ca981eb24cdaa5874f613f92cf39eafafe12b`; `espada-magisk` was
`bd5c0c1aaf29fa140b53556cc653f03dcca7f1a3`. The README still describes A9
and a general Kleaf build rather than a complete September ROM manifest.
No reproducible mapping from these branch heads to the downloaded image pair
was established. The existing stock-kernel pin therefore remains unchanged.

Implemented host safeguards now recheck current slot and firmware throughout
execution and after reconnect, and verify activation before success/reboot.
Signed production qualification additionally requires `encrypted-recovery`,
`recovery-after-ota-slot` and `kernel-vendor-module-pair`. These requirements
capture the newly identified boundaries; they do not claim the tests have run
on physical hardware or add an OTA/recovery adapter.

1. Inspect Espada's September source manifest, kernel/module coupling and patch
   level guard against our complete grizzly inputs. Build an isolated candidate;
   do not update firmware/source pins piecemeal.
2. Resolve the unofficial ROM's missing device/vendor provenance, firmware
   prerequisite and version-specific artifact list before considering its
   recovery/sideload route as an alternative adapter.
3. Cover fresh slot discovery after OTA/recovery transitions, recovery image
   assembly, encrypted-data access and partition teardown in real device tests.
4. Test networking and camera functionality after both clean installation and
   update; retain firmware, root variant and optional package identities in the
   evidence. A launcher screenshot is insufficient.
5. Keep existing installation eligibility disabled until the exact device and
   our signed artifact set pass qualification and stock recovery is established.

## Required physical evidence after connection

First collect exact product/SKU, firmware, lock/slot state and incident logs
without rebooting or writing. Then establish the matching stock recovery path
and resolve the previous failures. Keep installation disabled while the exact
grizzly image build and hardware qualification are missing.

For cellular qualification, retain carrier identity and matched radio/carrier
profile provenance; test incoming/outgoing calls, LTE/5G and Wi-Fi calling where
supported, DTMF, SMS and mobile data. A registered modem or a single successful
boot is insufficient. Do not place emergency test calls without the appropriate
coordinated test procedure. Keep personal modem/bugreport data outside Git.

The complete status and previously retained simulator evidence are in the
[readiness report](pixel11-readiness-2026-09-23.md). Host validation and Cuttlefish
evidence cannot certify retail bootloader behavior or guarantee zero brick risk.
