# Native OTA trust engine

Dependency-pinned Go verification for native Android hosts: TUF metadata and trust
rotation, constrained HTTPS, rollback/floor admission, rollout scheduling, bounded
APK/runtime verification, durable download/preparation and recovery authorization.
No method signs releases or independently authorizes PackageInstaller commits.

The reviewed signed host build must set the unexported
`github.com/elizaOS/eliza/packages/os/native/ota-trust.compiledHostPolicyBase64`
linker variable using `-ldflags=-X=...=VALUE`. VALUE is base64url without padding
of a strict JSON object containing schema (2), product, package, cohortDomain,
runtimeInventoryHeader and runtimeExcludedAgentDirectories. Empty or invalid policy
rejects product admission and runtime-artifact verification. There is no runtime
setter. Keep the product's existing salt when migrating deployed installations.

`VerifyRuntimeArtifact` reads `assets/agent-runtime.inventory`, the asset written by
plugin-native-agent's `stageAndroidRuntimeInventory`. Hosts pass the same
runtimeInventoryHeader (default `eliza-runtime-v1`) and excluded agent directories
to that packager, the policy and `RuntimeBundleStore`. Excluded directories and
archives re-addressed as listed blobs are covered only by the whole-APK digest.
`testdata/runtime-apk` is packager output; the plugin's native-host suite rejects drift.

Use Go 1.27.1. Run `go test -race ./...` and `go vet ./...` here. Tests include
historical downstream compatibility vectors; their product policy exists only
in test code. The independent-host test rejects another product's release.
These tests do not prove device-owner provisioning, installed update recovery,
full AOSP boot, production trust enrollment or real-device acceptance.

Release metadata uses a closed channel graph: top-level targets delegate only to
terminating `stable` and `beta` roles with their own keys. Devices and the
publication verifier refuse a Stable delegation whose threshold is below two, so
an admitted Stable release carries signatures from two distinct authorized
approver keys; Beta needs one. Each channel key must be a distinct public key
that shares no other role's authority, and go-tuf counts each authorized key
once, so a repeated signature or an aliased key cannot stand in for the second
approval. Who holds those keys is the host's decision.

Hosts retain trust-root provisioning, signing authority, repository/package
binding, update UI, permitted hardware and release/rollout policy. Native callers
must independently recheck current device state and installation authority.

Android hosts can call `buildAndroidTrust` from `scripts/build-android.mjs` with
their composed source directory, output AAR, pinned toolchain, Java namespace and
reviewed linker policy. The host supplies SDK/JDK environment paths and serializes
builds to that output. A failed build preserves the previous AAR. Run the build
contracts with `node --test scripts/build-android.test.mjs`; qualify the resulting
AAR in the consuming Android host before release.

`composeTrustSource` in `scripts/compose-source.mjs` combines an admitted shared
source directory, build-time host policy and optional consumer Go tests. The host
verifies its reviewed pin before calling. The composer hashes all inputs, rejects
test collisions and symlinks, and verifies cached bytes before reuse. Run its
contracts with `node --test scripts/compose-source.test.mjs`.

Runtime artifact verification accepts ARM64 or x86_64 only when that ABI appears
in the authenticated release artifact. Every inventoried native ELF must match
the selected machine, and its ABI-specific musl loader is required. Mixed loader
inventories fail. This does not qualify an x86_64 host for release or change
hardware, signing, rollout or installation policy.

Release hosts can call `ValidateReleaseDescriptor` without fabricating device
state. It applies the same descriptor and forward-recovery contract used by
native admission, with compiled product identity and an independently supplied
repository/host policy. `cmd/verify-release` reads bounded descriptor bytes from
stdin and requires `-repository` and `-hosts`; its JSON result binds the exact
input SHA-256 and explicitly reports `authenticated:false`. The invoking host
owns process cancellation and deadlines. This check does not verify signatures,
APK bytes, source approval, current rollout eligibility or publication authority.
Use the separate runtime and signed-publication verifiers for their respective
checks, and independently verify APK signing and public release evidence.
