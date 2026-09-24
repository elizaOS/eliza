# Pixel 11 upstream and elizaOS bring-up audit

Checked September 4, 2026 (America/New_York). Scope: public upstream research,
source refresh and preparation. No device flash, firmware update, MTE toggle,
remote AOSP build, or hardware qualification was performed for this audit.

## Bottom line

There is substantially more usable upstream work than the August 26 runbook
described. It is no longer accurate to say that no kernel work exists or that
Google's current GSI excludes Pixel 11. There is still no publicly listed
GrapheneOS Pixel 11 production release. Our immediate task is a coherent,
evidence-backed first boot, not claiming GrapheneOS-equivalent security.

Three problems must remain separate:

1. Kiosk mode is a running-app/provisioning issue; establish the phone's current
   state before interpreting it as an OS bring-up failure.
2. Our historical custom-image boot stall needs current logs and controlled
   comparisons. It has not been conclusively attributed to a missing AOSP API.
3. GrapheneOS's MTE qualification concerns its security requirements. It is
   not evidence that elizaOS cannot boot with the stock kernel.

## Verified upstream changes

### GrapheneOS announcements: the MTE assessment changed

The August 29 announcement described a partial port and an MTE blocker. On
September 1, GrapheneOS revised its assessment: some hardware MTE support
exists. Its follow-up reports QPR2 Beta 4 firmware support for reserving tag
memory, while the stock OS still disables MTE through `arm64.nomte`. Testing
requires a suitable non-stock kernel as well as firmware configuration.
Whether MTE is fully functional and its performance acceptable remained under
investigation in that thread. Reduced hardware acceleration, cost decisions
and CPU errata are hypotheses, not established explanations.
Sources: [August 29 announcement](https://bsky.app/profile/grapheneos.org/post/3mua32q4ds22e),
[September 1 revision](https://bsky.app/profile/grapheneos.org/post/3mugn23cpx22l),
[firmware details](https://bsky.app/profile/grapheneos.org/post/3mugndpsncs26),
[experimental requirements](https://bsky.app/profile/grapheneos.org/post/3mugnnmvofc26),
[remaining uncertainty](https://bsky.app/profile/grapheneos.org/post/3mugo3ilgjc2n).

The website's supported-device list stops at the Pixel 10 generation/10a and
the release page does not list Pixel 11. This means no listed production
support, not no ongoing port. Sources:
[supported devices](https://grapheneos.org/faq#supported-devices),
[releases](https://grapheneos.org/releases).

### Google: a newer, explicitly supported diagnostic control

Google's QPR2 Beta 4 factory and GSI pages carry an August 28 release date and
now include the Pixel 11 family. GrapheneOS separately reports that the
Pixel 11 factory files appeared later, around August 31; do not conflate the
release label with device-file availability.
Sources: [Google factory table](https://developer.android.com/about/versions/17/qpr2/download),
[GSI validation and downloads](https://developer.android.com/about/versions/17/qpr2/gsi-release-notes),
[GrapheneOS timing clarification](https://discuss.grapheneos.org/d/41564-pixel-11-doesnt-meet-the-grapheneos-security-standards-and-may-be-skipped?page=17).

Candidate diagnostic downloads, **not downloaded or promoted into our lock**:

| Artifact | Published identity | Published SHA-256 |
| --- | --- | --- |
| Pixel 11 Pro factory | `grizzly_beta-cp41.260814.003.c2-factory-6b68d2d6.zip` | `6b68d2d6ef7ddbb73be07bc8e0221b232982a39f7351a8162b4f75fb60d6fa83` |
| ARM64 AOSP GSI, without GMS | `aosp_arm64-exp-CP41.260814.003.B1-16166531-e6cb3bc5.zip` | `e6cb3bc521fb4a8b4c8e62f8557c6ae0ff10662a6838cfb346a32ec9c9134e22` |

The C2 factory and B1 GSI are different published artifacts from the same
release train, not interchangeable filenames. Verify the downloaded bytes
and current installation requirements before any experiment. Google labels
these development builds; they are not an elizaOS production base by default.

Live AOSP manifest tag enumeration still returned only `android-17.0.0_r1`
for `android-17*`, peeled commit
`5bc9a7ce1cd78dd53613bbfd0ebf506e1e4adb0f`. Binary beta availability does not
mean a matching full platform source release is available. Source:
[AOSP manifest refs](https://android.googlesource.com/platform/manifest/+refs).

### adevtool: a concrete partition/OTA defect, now addressed in our candidate

Upstream commit `97c519464a1cbe49b59aeff5143ba8edb44a98d9` corrected the
11th-generation super device from an inherited 8531214336 bytes to 10 GiB.
Its explanation explicitly distinguishes a bootable factory installation
from an OTA-compatible one: stale LP metadata can make update_engine reject
the corrected dynamic group. It calls for a corrected clean installation
before OTA testing. This is an OTA/layout defect, not a demonstrated cause of
our no-adb stall. Source:
[partition fix](https://github.com/GrapheneOS/adevtool/commit/97c519464a1cbe49b59aeff5143ba8edb44a98d9).

Subsequent commits generate partition settings from stock `super_empty.img`
and handle lpdump's string-encoded integers. This replaces manually inherited
geometry and adds `lpdump` to extraction dependencies. Sources:
[automatic extraction](https://github.com/GrapheneOS/adevtool/commit/7aae0dc918216dc527ebd46d806013b811ef13d7),
[JSON handling](https://github.com/GrapheneOS/adevtool/commit/9cd37d18459e18a02f08584e7e27cc2079b21da2).

Latest branch `17` was pulled and reviewed at
`144f004cc484d7e7234cdd167cee48e5f240288f` (September 3), 15 commits after our
old pin. Other changes concern bulletin processing and display-color defaults.
The grizzly factory selection remains A9. The generated BoardConfig is
3622 bytes, SHA-256
`533bf35c78f073958e82b3138eec378ae7f6f5c25545aa23de1173aa03d1545e`, matching
upstream's vendor specification. Sources:
[pinned upstream revision](https://github.com/GrapheneOS/adevtool/tree/144f004cc484d7e7234cdd167cee48e5f240288f),
[grizzly BoardConfig](https://github.com/GrapheneOS/adevtool/blob/144f004cc484d7e7234cdd167cee48e5f240288f/vendor-skels/google_devices/grizzly/BoardConfig.mk),
[grizzly specification](https://github.com/GrapheneOS/adevtool/blob/144f004cc484d7e7234cdd167cee48e5f240288f/vendor-specs/google_devices/grizzly.yml).

### Kernel: real progress, but not a drop-in replacement

The `kernel_common-6.12` Malibu bring-up PR merged August 27; its diff is a
small Pixel symbol-list update, not a complete device kernel delivery.
Source: [merged PR #29](https://github.com/GrapheneOS/kernel_common-6.12/pull/29).

More importantly, the September 4 branch includes
`3031767d5fd1ff6717a7c691653fc8361d0fc911`, disabling AutoFDO machine-function
splitting after a Kodiak/Malibu early-boot BTI exception with Clang 19. The
commit identifies a newer LLVM fix and notes stock A9 does not enable kernel
BTI. Consequently, this is actionable for a future hardened kernel build but
does not explain our unmodified stock kernel. Source:
[BTI/AutoFDO fix and trace](https://github.com/GrapheneOS/kernel_common-6.12/commit/3031767d5fd1ff6717a7c691653fc8361d0fc911).

The latest checked common-kernel head was
`5c8c954892a0009c6ba66a160b9a7b0ae8188659`. The common-kernel manifest inspected
does not itself supply a complete locked Malibu device build. We have not
verified a reproducible device kernel, vendor-module/KMI compatibility,
matching DTBO or firmware integration. The stock A9 kernel remains our
baseline; importing only a common-kernel commit would not close those gaps.
Source: [6.12 manifest](https://github.com/GrapheneOS/kernel_manifest-6.12/blob/17/default.xml).

## Missing, why, and how to close it

| Missing evidence or integration | Why it remains missing | Next action / completion evidence |
| --- | --- | --- |
| Current phone state | Kiosk report and historical boot-stall notes describe different conditions | Exact serial/product/build, slot and lock state; capture before reboot |
| Regenerated vendor and final LP metadata | New extractor changes generated output; local fixtures are not a real extraction | Linux `prepare-grizzly`, strict BoardConfig hash, effective variables, stock/output `lpdump`, complete build gates |
| Coherent beta baseline | Repository pins A9, while new MTE/GSI evidence uses QPR2 beta firmware | Separate factory/GSI control; verify archives and rollback policy; migrate firmware/vendor/requirements together only if justified |
| Root cause of the custom boot stall | Missing attributable boundary evidence; platform mismatch is still a hypothesis | Known-good log-retention control, then init/APEX/KeyMint/vold/VINTF comparison and one-variable experiment |
| Honest SELinux compatibility | Prepare still rewrites vendor's 202604 declaration to 202704 | Prove actual CIL/mapping and VINTF compatibility; remove rewrite only with build and boot evidence |
| Hardened custom kernel and MTE | Public changes do not supply our locked device integration or performance qualification | Source/toolchain/module/DTBO lock, reproducible build, hardware MTE correctness and performance tests; no automatic security downgrade |
| Finished product | A built image or launcher appearance is not full device acceptance | Probe-free boot, secure storage, local inference/voice, hardware matrix, OTA/recovery/rollback, exact-digest qualification and release signing |

The sepolicy rewrite, keymaster nonblocking option and graphics overrides are
not repaired by inventing a compatibility claim or enabling every workaround.
The updated [runbook](grizzly-bringup-runbook.md) gives the experiment order.

## Repository changes made

- Started from fetched `origin/develop` (`46cc9c9`) in an isolated worktree,
  preserving the original checkout. Incorporated existing PR #91's host-init
  target fix rather than treating it as new discovery.
- Advanced only the grizzly adevtool pin to the reviewed September 3 SHA.
  Added required generated partition declarations and an exact BoardConfig
  artifact digest. Existing stale output cannot pass the updated contract.
- Bound evidence probes to the selected serial, rejected ambiguous devices,
  and stopped treating model text or failed inventories as shell availability.
- Added read-only MTE/bootconfig, super/LP, APEX and service inventory probes;
  corrected unsupported pstore-retention assurances.
- Replaced stale runbook conclusions with evidence-bounded controls and added
  positive/failure-path tests. No application source was copied into this repo.
- Corrected AOSP test fixtures to use canonical temporary paths and check
  held descriptors directly rather than assuming Linux `/proc`. This fixes
  six Mac test failures without weakening production path/descriptor checks.

Unchanged: AOSP/resolved platform manifest, A9 factory and rollback archives,
stock kernel/DTBO hashes, vendor-state pin, diagnostic defaults, signing policy
and hardware eligibility. Latest checked `vendor_state` remains
`afd6a0c9f6ca13d395f00e98227a0866cc14de07`; GrapheneOS platform manifest head
remains `aee72ee010700905b6e3d1315cf7f5f2371a0276`.

## Search coverage and limits

Read official GrapheneOS Bluesky posts/thread through the public API, reviewed
its recent main-post feed, searched the web and X, read GrapheneOS website and
forum updates, inspected GitHub commits/PRs/source, Google's beta/GSI pages,
AOSP refs and LineageOS's official device-data listing. No Pixel 11 codename
entry was found in that LineageOS listing; this is not proof no private or
unofficial work exists. Source: [LineageOS device data](https://github.com/LineageOS/lineage_wiki/tree/main/_data/devices).

Direct retrieval of the official X profile failed (403 on the initial attempt;
subsequent web retrieval also failed), and indexed X searches did not yield a
verifiable current official thread. X was searched, but it is not independent
corroboration here. No claim of exhaustive social coverage or access to private
upstream discussions is made.

## Verification results

Local host: macOS, Node 24.5.0, Bun 1.3.14.

- `bun install --frozen-lockfile`, repository layout, workspace typecheck and
  workspace lint passed. Changed JavaScript/TypeScript/JSON passed Biome.
- `bun run test:release` passed: 181 Node tests passed, two Linux-specific
  tests skipped; 103 Bun tests passed after the AOSP fixture corrections.
- The separately invoked artifact-attestation suite passed all nine tests.
  The new evidence/geometry suites passed six tests, and the AOSP contract
  suite passed all 54 tests.
- The exact BoardConfig file from the fetched upstream revision passed our
  generated-text and byte/digest contract. This is upstream-file validation,
  not a local vendor-generation run.
- `bun run verify` stopped at the Linux-only native compiler gate on macOS.
  Separately running workspace `bun run test` hit seven Linux-installer
  failures (including unsupported Linux abstract Unix sockets); Turbo then
  interrupted sibling suites. The full verification gate is **not green**.

This audit does not certify that the new extractor has run on our Linux AOSP
tree or that an image built from this revision boots. Those are the next
execution boundary, not a reason to mark the device supported now.
