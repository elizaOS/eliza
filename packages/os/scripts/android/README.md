# Android tooling

AOSP builds, device deployment, runtime qualification, signed releases and
installation. Use the [Android build commands](../../android/README.md) and each
script's `--help`. Application sources resolve through
[eliza-source.ts](../eliza-source.ts).

Physical writes and publication require a signed v2 contract. Run contract tests
with `bun run --cwd packages/os test:release` from the repository root.

Browser staging binds the launcher package and certificate to one reviewed APK
pin. Upstream snapshots use `org.chromium.chrome`; owned components use
`ai.elizaos.chromium` and require the matching `chrome_public_manifest_package`
GN argument. Owned pins and build provenance must explicitly carry
`launcherApplication` and `launcherSignerSha256`; the overlay and all current
component resources must bind to the same launcher. Missing identities, stale
resource inventories and conflicting host configurations are rejected. This
admission checks build evidence, not installed native-channel behavior.
The owned package starts a new profile; retain the upstream app for
rollback and select the new profile explicitly rather than copying profile grants.

Use `node packages/os/scripts/android/sim.ts --aosp-root /path/to/aosp`
from the repository root to launch and validate Cuttlefish. It shares the image
builder's GPU configuration and `OUT_DIR`/`OUT_DIR_COMMON_BASE` resolution, and writes evidence to `test-results/os-aosp-sim/`.
An existing instance must be stopped explicitly before launching another;
`--stop-after` stops the selected environment after validation and reports failures.
