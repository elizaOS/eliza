# Android release and installation contracts

Physical writes and update publication require a signed v2 contract. Legacy
installer manifests remain available for dry-run/discovery only. No physical
target is enrolled today. This intentionally blocks release and installation
until independent qualification and trust enrollment are complete.

## Entrypoints

- `install-release.mjs`: authenticated, serial-bound Linux installer; also
  reached through `install-elizaos-android.sh --execute --confirm-flash`.
- `release-contract.mjs`: shared validation for installation and publication.
- `publish-update-manifest.mjs`: verify contracts, archive hashes and ZIP member
  contents before producing an index with embedded signed contracts.
- `verify-installed-release.mjs`: read-only post-boot checks using that contract.
- `sign-contract.mjs`: offline signing; does not generate or enroll keys.
- `sign-revocations.mjs`: offline signing of an expiring revocation bulletin.
- `record-cuttlefish-result.mjs`: build-only versus boot-workflow status. This
  unsigned receipt is evidence input, never a qualification authorization.

Node 24 and Python 3 are required for publication. Linux execution additionally
requires the exact qualified adb/fastboot binaries. macOS and Windows remain
planning-only for v2; do not use a VM USB workaround as qualification evidence.

## Contract format and trust

`*.android-release.json` is an envelope with `schemaVersion: 2`, `release`,
`qualification` and `signatures`. `release-contract.mjs` is the authoritative
validator. Tests construct complete examples with temporary keys and mock
images; these are not device artifacts or production keys.

The release contains:

| Field | Required meaning |
| --- | --- |
| `releaseId`, `version`, `tag`, `channel` | Exact release identity and canary/beta/stable channel. |
| `operation`, `artifactType` | `os-install` or `lab-experiment`, and `factory`. OTA/firmware transitions are separate, currently unsupported adapters. |
| `target` | Exact id, codename, physical/virtual kind, architecture, page size; physical SKU and measured userdata-capacity allowlists. |
| `buildFingerprint`, `buildType` | Exact running identity; public physical installation requires `user/release-keys`. |
| `diagnostics` | Explicit booleans for init probes, keymaster nonblocking, graphics/fstab overrides and sepolicy version rewrite. All false for public releases. |
| `sources` | OS/application/AOSP commits and source-lock, vendor, kernel, APK and original bundle digests. |
| `archive`, `archiveRoot`, `files` | Archive and per-file filename, byte count and SHA-256; archive root is empty or `flash/`. All referenced images are mandatory. |
| `strategy`, `planSha256` | Physical adapter is `grizzly-fastboot-info`; plan hash binds the generated metadata. Cuttlefish uses `virtual`. |
| `geometry` | Qualified grizzly super/group geometry and exact probed physical partition sizes. |
| `tools` | Exact adb/fastboot SHA-256 and version output substring. |
| `avb` | Expected key digest, algorithm, production-key status and rollback locations/values. Public AOSP test keys do not qualify production. |
| `startingStates` | Exact firmware pair, current/target slots, slot-health getvars, required wipe decision, evidenced rollback policy and documented recovery archive. |
| `minimumBatteryPercent` | Qualified reliable probe, at least 30%; missing/unknown probe blocks writes. |
| `validation` | Boot timeout (30–1800 seconds), flash-command timeout (300–1800 seconds). |

`qualification.subjectSha256` is the SHA-256 of canonical `release` JSON.
Canonicalization sorts object keys recursively and preserves array order.
Qualification has issue/expiry dates and evidence digests. Every SKU × measured
storage capacity × starting state needs a case (`sku`, `storageBytes`,
`startingStateId`, `evidenceSha256`, `checks`). Required physical/virtual check
names are exported by the validator. Any changed release field invalidates
qualification and signatures.

Physical qualification explicitly includes encrypted recovery, recovery slot
identity after OTA and the matched kernel/vendor module set.
During execution, firmware and current-slot probes must remain equal to the
qualified state through bootloader/fastbootd transitions. After activation the
installer verifies the target slot before recording activation or rebooting.
Missing probes and a command reporting success without the requested slot
change fail closed. These host guards still require physical qualification.

Each signature covers UTF-8 canonical JSON of exactly
`{schemaVersion:2, release, qualification}`. Two different Ed25519 public keys
are mandatory, for `release` and `qualification` roles. Distinct IDs pointing
to the same key cannot satisfy independence. Enroll public keys through review
in `android/release-trust.json`, with id, publicKey (SPKI PEM),
roles, channels, operations and expiresAt. Never commit private keys.

The trust policy also needs an authenticated `revocationBulletin`, signed by a
trusted key with role `revocation`, and a pinned `minimumRevocationSequence`.
The signed bytes are JSON of the tuple `[schemaVersion, sequence, issuedAt,
expiresAt, revokedReleaseDigests, revokedKeyIds]`. Expired, future, invalid or
below-floor bulletins block authorization. Increase the reviewed sequence floor
when distributing a new bulletin; clients must receive updated trusted policy.
There is no background network fetch and offline clients cannot learn a new
revocation before policy delivery. Keep bulletin lifetimes short enough for the
release policy. Immediate local deny lists remain available in the trusted file.

## Scoped lab experiments

`lab-experiment` is canary-only, requires separately scoped signing keys and
`labExperimentsEligible: true` in the reviewed inventory, and never authorizes
publication as an installable release. Qualification status is
`experiment-authorized`; cases require stock-baseline, recovery,
firmware-rollback-policy, cuttlefish-boot and artifact-validation evidence.
Diagnostic options and development keys can be explicitly bound to the
experiment. No unrestricted force, unsigned image override, firmware write,
MTE toggle or relock path exists. Both production and lab eligibility remain
false for grizzly until the corresponding evidence is reviewed.

## Signing and execution

Prepare the release and real qualification evidence first. Signing is an
explicit offline operation using private keys retained outside the repository:

```sh
node scripts/android/sign-contract.mjs unsigned.json release RELEASE_KEY_ID /secure/release.pem release-signed.json
node scripts/android/sign-contract.mjs release-signed.json qualification QUALIFICATION_KEY_ID /secure/qualification.pem qualified.android-release.json
node scripts/android/sign-revocations.mjs bulletin.json REVOCATION_KEY_ID /secure/revocation.pem bulletin-signed.json
```

These tools create new output files and do not enroll trust or enable a target.
Only reviewed policy changes can do that. Do not substitute passing labels for
hardware receipts, or edit inventory to get around missing evidence.

For an authorized contract, inspect its possible plans without accessing USB:

```sh
node scripts/android/install-release.mjs --manifest qualified.android-release.json --artifact-dir /absolute/bundle/flash --dry-run
```

Execution starts with the selected phone already in bootloader mode. This
avoids an automatic reboot that could discard incident evidence. It requires
an explicit serial, private new journal, retained recovery archive and pinned
tools. The wipe choice must exactly match the qualified starting-state policy:

```sh
node scripts/android/install-release.mjs --manifest qualified.android-release.json --artifact-dir /absolute/bundle/flash --device SERIAL --tool-dir /absolute/platform-tools --recovery-dir /absolute/recovery --journal /absolute/evidence/install.jsonl --health-token-file /absolute/private/local-agent-token --execute --confirm-flash --reboot-after-flash
```

Add `--wipe-data` only for a qualified transition requiring it. Without reboot,
the result is `installed-awaiting-boot-validation`. With reboot, verify exact
fingerprint/slot/page size, enforcing SELinux, privileged APK digest, HOME and
ASSISTANT roles and local agent health. This is installation verification,
not a replacement for the complete hardware/voice/OTA qualification matrix.

Artifacts are copied to private staging and rehashed before each write. Tools
are rechecked, reconnects are bounded, mode/identity/snapshot state are asserted
before dependent commands and results are fsynced to the journal. Failures
stop the sequence. There is no blind resume, automatic slot rollback, snapshot
cancellation or automatic relocking. A host account compromise can still alter
its own trusted code/policy; this is not a security boundary against that host.

## Remaining real-world qualification

The builder emits `android-contract-candidate.json` with `authorized: false`.
A build receipt is never automatically promoted into a signed release. The
current grizzly source still has an unresolved sepolicy declaration rewrite
and uses a stock kernel; signing cannot repair those compatibility questions.

Before promotion: diagnose the two incidents, establish stock/GSI controls,
inspect final LP/AVB/VINTF/ramdisk/module artifacts, boot without diagnostic
bypasses, exercise the hardware matrix, full/incremental/interrupted OS update,
recovery, downgrade rejection and secure-storage behavior. Test locked boot
only in a separate qualified signing/recovery project. These scripts never
relock a device.

Post-boot validation requires `--health-token-file` pointing to a private (0600)
file containing the installed application’s local agent bearer. It is passed
over adb stdin, never in command arguments or journals; health must return
`ready: true`. For a first install or wipe where that credential is not yet
available, omit `--reboot-after-flash`, complete the qualified boot/setup
procedure, then run the standalone validator with the new credential. Missing
credentials never count as successful validation. Do not commit this file.

Post-boot health uses the authenticated NDJSON abstract socket
`eliza_local_agent_v1`, through a temporary serial-bound ADB forward. The
private token file is passed to the probe over stdin; no device TCP health
listener is required. A failed probe or forward cleanup is a verification
failure.

## Concurrent or interrupted installation

The Linux installer acquires a private per-serial interlock under
`~/.local/state/elizaos/android-install-locks/` before device inspection and
holds it through staging, writes, and requested boot verification. The lock
records the PID, release digest, journal location, and phase. Separate installs
by the same OS account cannot write the same serial concurrently, even from
different repository checkouts.

A normal completion or pre-write error removes the lock. Once writes may have
started, failure retains it; process death also leaves it behind. There is no
automatic stale-PID recovery or resume flag. Before manually removing a lock,
verify the installer and its child tools have stopped, retain its journal, and
inspect the actual phone and recovery path. Retry only a separately qualified
starting state; never infer it from the last successful command. This interlock
does not control raw fastboot commands, another OS account, or another host.
