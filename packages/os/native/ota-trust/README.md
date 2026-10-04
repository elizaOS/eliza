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
