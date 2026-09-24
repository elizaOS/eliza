# Android installation safety implementation

This change implements host-side safeguards from the September 22 Pixel 11
research plan. It does not qualify a Pixel image or diagnose the two reported
failures. The original source pins and vendor/kernel baseline are preserved.

| Plan stage | Implemented | Remaining real boundary |
| --- | --- | --- |
| Immediate safety | Unconditional erase rejection; strict conditional wipe order; publication validates signed contracts and archive members in private temporary staging. | Review and merge; exercise real release artifacts after trust enrollment. |
| Shared contract | Versioned exact-target contracts, source/image/tool digests, SKU/storage/firmware/slot/recovery policy, AVB metadata, expiring qualification and independent signatures. | Populate from actual build and lab evidence; independently enroll production public keys. |
| Checked installation | Linux grizzly adapter, serial/mode/snapshot assertions, artifact staging, per-write checks, bounded execution, durable journals, scoped lab authorization and exact post-boot runtime checks. | Test the adapter on qualified sacrificial/lab hardware; other host/device adapters remain unsupported. |
| Incident diagnosis | Collector verifies identity before OEM probes; private evidence storage and state-dependent recovery guide. | Two phones' original logs, exact identities/firmware/lock state and available transports; stock/GSI control and root-cause diagnosis. |
| Cuttlefish/hardware | Existing shared build/runtime lane preserved; machine-readable build-only status; signed promotion requires complete matrix. | Boot exact new outputs in Cuttlefish; physical radio, encryption, keystore, camera, voice, thermal, OTA, recovery and rollback qualification. |
| Signing/rollout | Offline Ed25519 signing, independent release/qualification roles, scoped channels/operations, signed expiring revocations and monotonic policy floor. | Secure key custody/enrollment, locked-boot/OTA signing validation and controlled canary rollout. No relock or firmware-transition executor is provided. |

The grizzly builder emits `android-contract-candidate.json` with authorization
false, including host provenance and explicit blockers. A generated candidate
is not automatically converted into passing hardware evidence. The existing
SELinux declaration rewrite must still be resolved with real CIL/mapping,
VINTF and boot evidence. Diagnostic flags must all be false for public release.

Neither the stock kernel nor the newer upstream firmware/tool pins were
changed: upgrading those independently could invalidate the current baseline.
The updater index is v2 and embeds signed contracts. Any consumer in
`elizaOS/eliza` must explicitly support and verify that format before release;
there is no unsigned v1 downgrade for compatibility.

Host tests cover successful simulated installation and failure cases including
unsafe erase, ambiguous getvars, wrong model/SKU/storage/firmware/slot/mode,
unknown battery/snapshot state, altered files/tools, stale/revoked signatures,
missing qualification, independent-key enforcement, mismatched ZIP contents,
interrupted writes and post-boot fallback/unhealthy runtime. They are not
physical boot evidence.

Use the [contract guide](../../../../scripts/android/README.md) for operation
and signing details. Do not flip eligibility or add test keys to production
trust merely to make an install proceed.

## Verification for this implementation

On the Linux worktree based on `develop` at `47a1b5012`:

- `bun install --frozen-lockfile` and `bun run verify` passed, including the
  native installer compiler check, workspace checks, 219 Node release tests
  and 113 Bun contract tests.
- The separate Android installer mock suite passed all 19 cases.
- Changed JavaScript/TypeScript/JSON passed Biome; workflow YAML parsed and
  the ZIP verifier passed Python syntax checks.
- ADB and fastboot inventories contained no phones. The existing local AOSP
  output lacked a Cuttlefish launcher and completed image set. No device was
  flashed, rebooted, relocked or promoted, and no real boot evidence is claimed.

Keep the PR in draft until the new executor has undergone independent review
and the relevant platform validation. Production key enrollment and hardware
eligibility require separate evidence-backed changes.
