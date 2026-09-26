# AOSP build orchestration

Brand configuration, privileged APK staging, vendor sync, and image builds for
Cuttlefish and supported Pixel targets. Use the [Android Makefile commands](../../android/README.md).
Application source is resolved by [eliza-source.ts](../eliza-source.ts).
The application build owns launcher icons and app splash assets; OS builds
consume its staged privileged APK.

Browser staging binds the launcher package and certificate to one reviewed APK
pin. Upstream snapshots use `org.chromium.chrome`; owned components use
`ai.elizaos.chromium` and require the matching `chrome_public_manifest_package`
GN argument. The owned package starts a new profile; retain the upstream app for
rollback and select the new profile explicitly rather than copying profile grants.

Use `node packages/os/scripts/distro-android/sim.ts --aosp-root /path/to/aosp`
from the repository root to launch and validate Cuttlefish. It shares the image
builder's GPU configuration and `OUT_DIR`/`OUT_DIR_COMMON_BASE` resolution, and writes evidence to `test-results/os-aosp-sim/`.
An existing instance must be stopped explicitly before launching another;
`--stop-after` stops the selected environment after validation and reports failures.
