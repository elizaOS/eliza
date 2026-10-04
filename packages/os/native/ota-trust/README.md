# Native OTA trust engine

Dependency-pinned Go verification for native Android hosts: TUF metadata and trust
rotation, constrained HTTPS, rollback/floor admission, rollout scheduling, bounded
APK/runtime verification, durable download/preparation and recovery authorization.
No method signs releases or independently authorizes PackageInstaller commits.

The reviewed signed host build must set the unexported
`github.com/elizaOS/eliza/packages/os/native/ota-trust.compiledHostPolicyBase64`
linker variable using `-ldflags=-X=...=VALUE`. VALUE is base64url without padding
of a strict JSON object containing schema (1), product, package, cohortDomain and
runtimeInventoryHeader. Empty or invalid policy rejects product admission and
runtime-artifact verification. There is no runtime setter. Keep the product's
existing salt and inventory header when migrating deployed installations.

Use Go 1.26.8. Run `go test -race ./...` and `go vet ./...` here. Tests include
historical downstream compatibility vectors; their product policy exists only
in test code. The independent-host test rejects another product's release.
These tests do not prove device-owner provisioning, installed update recovery,
full AOSP boot, production trust enrollment or real-device acceptance.

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
