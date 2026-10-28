# Android tooling

AOSP builds, device deployment, runtime qualification, signed releases and
installation. Use the [Android build commands](../../android/README.md) and each
script's `--help`. Application sources resolve through
[eliza-source.ts](../eliza-source.ts).

`verify-source-lock.ts --profile pixel10a` and the exported `verifyProfileSource`
share full Pixel 10a/stallion source admission between product orchestrators.
See the Android README for required source/archive inputs and qualification limits.
The lower-level `verifyDeviceSource` accepts caller-authenticated patch envelopes;
it never applies patches or changes the source tree.

Pixel products keep the factory vendor partition. `vendor-api.mjs` checks that
the lunch release configuration's `RELEASE_BOARD_API_LEVEL` and the generated
vendor VINTF sepolicy version both equal the locked `vendorApiLevel` (grizzly's
lock and the `pixel10a` profile in `android/aosp.lock.json`);
`stage-pixel10a-product.ts` refuses a mismatch instead of rewriting VINTF.
Every brand's Pixel 10a composition also declares its launcher's versioned
`<package>.aosp_image` system feature in the product partition
(`image-capability.mjs`), the marker image-only native surfaces require along
with a system-partition install. A presigned launcher that instead reads an
overlayable boolean (default false, `system|product` policy) names it in the
product's `launcher.imageProvisioning`; production compositions then add the
static product-partition resource overlay `writeImageProvisioningOverlay`
generates, and `assertProvisioningResourceDefault` checks the host's default.

`secure-camera.mjs` keeps capture over Keyguard with the stock AOSP Camera2
`SecureCameraActivity` and the SystemUI power gesture for every brand: it
authenticates the reviewed source inputs in `android/sources/secure-camera.json`,
stages the Camera2 product overlay, refuses a launcher manifest that shows over
Keyguard or handles the secure capture actions, and runs read-only image checks.
It never proves locked-capture isolation, unlock return or device acceptance.

Pixel 10a release signing (`aosp-release-signing.mjs`, Eliza's
`sign-pixel10a-release.mjs`), compatibility records (`aosp-release-record.mjs`), the
operator OTA update client with interrupted-update, fallback and stock-recovery
tooling (`aosp-ota-update.mjs`) and read-only image checks (`verify-launcher-image.mjs`)
take each brand's release descriptor and channel; see
[the release guide](../../android/releases/README.md).

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
