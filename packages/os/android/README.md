# elizaOS Android

AOSP vendor overlays and build orchestration for Cuttlefish and supported Pixel
products. A full image build requires a Linux x86_64 builder, the pinned AOSP
checkout, Android build dependencies, and Eliza workspace dependencies. Cuttlefish
launches require KVM except for the RISC-V TCG path.

From the repository root:

```bash
make -C packages/os/android bootstrap AOSP_ROOT=/path/to/aosp
make -C packages/os/android bootanimation
make -C packages/os/android build ARCH=x86_64 AOSP_ROOT=/path/to/aosp \
  ARGS="--allow-development-browser"
```

`ARCH` accepts `x86_64`, `arm64`, or `riscv64`. `build` stages native inference,
rebuilds the unsigned image APK, syncs the vendor tree with the staged launcher,
builds AOSP, then launches and validates Cuttlefish. Sign that APK and pass it as
`ARGS="--launcher-apk /absolute/signed.apk --development-launcher"` (or
`--launcher-descriptor` for a reviewed release), or stage it first; see
[Eliza image launcher](#eliza-image-launcher). `make -C packages/os/android help`
lists hardware-specific commands. Building an image does not flash a physical device.
The Pixel 11 Pro lock targets stock B1 (`CD1A.260905.001.B1`) with the pinned
Android 17 `cp2a` release and vendor API `202604`. Its hashed vendor reference is
a build input; physical installation still requires qualification and a signed contract.
The shared `pixel10a` profile in `aosp.lock.json` pins the Pixel 10a (`stallion`)
Android 17 source inventory in `sources/pixel10a-stallion.json`. Eliza and Alpha
can both consume it; product branding does not select a different hardware source.
It is distinct from Pixel 10 (`frankel`/`blazer`/`mustang`) and Pixel 11 Pro.

Verify the full prepared source tree and matching factory archive without writing
to either input:

```bash
node packages/os/scripts/android/verify-source-lock.ts --profile pixel10a \
  --aosp-root /absolute/aosp --vendor-archive /absolute/stallion-factory.zip
```

This profile binds all 1,087 project revisions, manifest configuration, 16 reviewed
source overrides, 6,360 generated files, and recorded ignored inputs. The inventory
is copied byte-for-byte from Alpha's reviewed source contract (SHA-256
`760a7184c62c93aeac40595cf5733f8089aa16ccd28eb7a5f5ce41d4dae741d3`).
Alpha names inside that immutable inventory identify provenance, not launcher branding.
Pixel staging uses the reviewed `patches/soong-app-native` extension because
Android 17 image products can omit legacy Android.mk application modules. Apply
that exact patch in the prepared AOSP checkout and pass `--applied-app-native-patch`
to `stage-pixel10a-product.ts`. Source verification checks its original and patched
file hashes. The shared native stager then converts its admitted APK/JNI payloads
to Soong rules after product composition, preserving companion definitions,
nonprivileged launcher policy, executable modes and payload bytes. Conversion
alone does not prove that an image built or booted.

An API consumer can pass independently authenticated, reviewed patch envelopes to
`verifyProfileSource` or `verifyDeviceSource`; exact baseline preimages and postimages
are checked, and every other source fence remains in force.

A product's explicit brand config can select `aospLockPath: "android/aosp.lock.json"`
and `aospLockProfile: "pixel10a"`. `build-aosp.ts` runs the same full source check
before staging; supply `--vendor-archive` or `ELIZA_PIXEL_VENDOR_ARCHIVE`. The default
Cuttlefish selection is unchanged. Selecting a source profile does not supply a
hardware product, alter APK privileges, or qualify an image. Both products compose
the same least-privilege Pixel 10a product; release signing, compatibility records,
the operator update client and rollback/recovery tooling are described in
[releases/](releases/README.md). Both still need their real image, signing, voice,
telephony, update/recovery drills and physical-device validation. `pixel10a-stallion`
therefore stays installer- and lab-ineligible, and `releaseQualified` stays false.
The `eliza_gsi_arm64` and `eliza_gsi_x86_64` lunch targets build system-only
images from the `gsi-android17` (`cp2a`) profile in `aosp.lock.json`, not from the Cuttlefish
checkout; `make build` does not select them. They use system_ext SELinux policy,
are userdebug-only, and `generic-mediatek-gsi` stays blocked in
`hardware-targets.json`. Every product requires Android 17 (SDK 37).
Builds leave existing Cuttlefish sessions running. Stop selected instances
explicitly when reclaiming memory before a build.

Application sources resolve to the enclosing Eliza checkout. Set
`ELIZAOS_ELIZA_ROOT` to use another checkout. Native scripts and APK assets live under
`packages/app`, not this vendor tree. Licensed device inputs and release-signing
material must be supplied separately.

Browser images require the full Chromium APK and Bitwarden APK pinned in
[`vendor/eliza/manifests/browser-apps.json`](vendor/eliza/manifests/browser-apps.json).
Download the upstream artifacts named there, extract Chromium's APK, then stage
with Android SDK `apksigner` and `aapt` on `PATH`:

```bash
make -C packages/os/android stage-browser-apps ARCH=x86_64 \
  ARGS="--chromium-apk /absolute/ChromePublic.apk --bitwarden-apk /absolute/bitwarden.apk --allow-development-browser"
```

Staging verifies hashes, pinned APK signatures, package identities, versions and ABI.
AOSP sync rejects missing or changed artifacts. Both apps remain nonprivileged and
signed by their pinned publishers. Chromium pins select separate x86_64 and ARM64 development
snapshots and stage them under architecture-specific directories. Use `ARCH=arm64`
for Pixel builds. Neither snapshot is release-qualified; RISC-V has no pinned artifact.
Bitwarden remains locked until the user signs in and enables Android Autofill and
passkeys. Its F-Droid build requires manual vault sync. The launcher's Passwords
screen provides setup, backup and recovery guidance without accessing vault data.

Owned background browser control requires the reviewed Desktop Android Chromium
component build. Build the bridge extension with
`ELIZA_BROWSER_ANDROID_CERTIFICATE` set to the launcher signer, then prepare a
pristine checkout using the component generator (not the old allowlist-only patch):

```bash
make -C packages/os/android prepare-chromium-browser \
  ARGS="--source /absolute/chromium/src --extension /absolute/extension/dist --out /absolute/new-overlay --certificate <launcher-sha256>"
```

Preparation checks the generator's pinned revision/source hashes and applies its
six-resource component overlay, retaining default native verification. Build
`chrome_public_apk` with explicit Desktop Android GN arguments afterward.

Manifest schema 3 reserves Chromium `kind: "owned-component"` variants for exact
APK hash, signer, package, version and ABI pins. Their `component` binds schema 1,
Chromium revision, extension ID, launcher signer and a hashed provenance reference.
That document binds the APK identity, reviewed overlay/patch, six extension assets
and GN arguments through `{path, sha256}` references under
`manifests/browser-provenance/<arch>/`. This adds integrity evidence, not another
signature authority. No owned APK pin is supplied yet. Stable owned admission and
runtime qualification claims remain refused until a real qualification contract
and production signing inputs exist; staging never claims release qualification.

Current snapshots and future owned debug candidates require explicit
`--allow-development-browser` at staging, build and sync. Only `userdebug`/`eng`
AOSP targets may admit them. Sync rechecks copied bytes before replacing vendor
output. Launcher builds derive `ELIZA_CHROMIUM_CERT_SHA256` from the selected pin
and reject a conflicting override. Bitwarden's upstream source/signature contract
is unchanged. Development unpacked-extension proofs do not qualify release builds.

## Builder hosts, release keys and device qualification

- [`builder/`](builder/README.md): dry-run-first GCE and bare-metal builder and
  Cuttlefish host provisioning, plus `sync-aosp.sh` for mirrors and snapshots of
  a profile in `aosp.lock.json`.
- [`signing/`](signing/README.md): offline key ceremony for the AOSP image keys
  and the Ed25519 release keys, and the signing-environment decryptor.
- [`releases/`](releases/README.md): Pixel 10a release descriptors and update
  channels, the signing job, compatibility records, the operator OTA update client
  and rollback/recovery tooling.
- Read-only device qualification against a requirements file. The shipped
  [`device-requirements/treble-gsi.json`](device-requirements/treble-gsi.json)
  checks Treble/GSI readiness; products pass their own thresholds. An `identity`
  requirement uses `field` (`manufacturer`, `model`, `device`, `fingerprint`, or
  `vendorFingerprint`) and a nonempty exact `equals` value to bind observations
  to a reviewed SKU/baseline. Missing values remain incomplete:

  ```bash
  node packages/os/scripts/android/device-qualify.ts --serial SERIAL \
    [--requirements product.json] [--fastboot]
  ```

  adb mode runs a fixed, tested allowlist of read-only commands; fastboot mode
  runs only `getvar`. Records go to `test-results/os-device-qualification/` and
  label emulator captures `emulator-observation`. A pass is an observation, not
  a GSI boot. It complements, and never replaces, the `hardware-targets.json`
  admission gate (`installerEligible`, `blockedReasons`) for supported targets.

## White-label builds

Keep private branding outside the repository and point `ELIZA_WHITELABEL_DIR`
at it. `brand.json` (schema 1) names `appName`, optional `iconBackgroundColor`,
`icon`, `splash`, `splashMark` (required for Cloud APKs) and
`bootanimation.{logo,background}`. It cannot change the package ID, URL scheme
or signing; unknown fields fail the build. Same-ID white-label APKs build in the
app's own Android directory, never the tracked shared tree.

```bash
export ELIZA_WHITELABEL_DIR=/absolute/private/brand
bun run --cwd packages/app build:android:cloud
make -C packages/os/android bootanimation
```

The rendered frames and `bootanimation.zip` are gitignored build outputs.

## Eliza image launcher

Eliza's own Cuttlefish (x86_64, arm64, riscv64, riscv64 E1), GSI and grizzly
products install Eliza with the nonprivileged-launcher profile, as the Pixel 10a
Eliza product does. There is no priv-app placement, platform certificate, privapp
allowlist, init grant or app SELinux policy, and no Soong override removes a stock
app: the stock launcher, dialer, messaging and Clock stay installed as recovery
paths. The image preassigns default HOME, the assistant role and, when the APK
declares one, the Autofill service. Dialer and SMS are not preassigned.

`build:android:system` writes an unsigned `vendor/eliza/apps/Eliza/Eliza.apk`.
Sign it (the release signer for a release; a developer key for development
images), then stage it:

```bash
node packages/os/scripts/android/image-launcher.ts \
  --brand-config packages/os/scripts/android/brand.eliza.json \
  --apk /absolute/signed.apk --development --source-commit ELIZA_COMMIT
```

A release passes `--descriptor /absolute/reviewed.json` instead of
`--development`. `android/products/eliza-images.json` is the reviewed policy: the
launcher identity, the first-boot runtime grants (revocable `RECORD_AUDIO` and
`POST_NOTIFICATIONS`), each product's partition (GSIs use `/system`, everything
else `/product`) and its native installation target. A reviewed descriptor must
match that policy exactly. Staging pins the APK hash and certificate, writes
`vendor/eliza/launcher/` (gitignored) and `image-launcher.json` staging evidence,
and refuses a product it was not staged for when the product makefile is read.
`sync-to-aosp.ts`, `validate.ts` and `build-grizzly-bundle.ts` re-verify those
pins.

The launcher runs as `untrusted_app`, which may not execute app data (AOSP's W^X
neverallow), so the resident runtime must be installed beside the APK. Only
`eliza_cf_x86_64_phone` has a native installation target today; it requires
`--source-commit` and stages the admitted runtime under
`/product/app/Eliza/lib/x86_64/`. The other products stage without the resident
runtime, and production staging refuses them until they have a target.

Installed data is kept across the change: Android retains a system package's data
when its signer changes with a system update, and the package name and UID do not
change. Permissions the APK still declares but the image no longer grants
(`PACKAGE_USAGE_STATS`, `MANAGE_APP_OPS_MODES`, `INJECT_EVENTS`, `READ_FRAME_BUFFER`
and the other former priv-app permissions) fall back to their user-granted or
unavailable paths.

This is staging only. A built image, a Cuttlefish boot (`boot-validate.ts`) and a
device run are separate evidence.

## Downstream launcher APKs

Stage an independently built HOME application without replacing the Eliza runtime
or inheriting its permission list:

```bash
node packages/os/scripts/android/stage-launcher-overlay.ts \
  --descriptor /absolute/launcher.json --apk /absolute/launcher.apk \
  --output /absolute/new-vendor-directory
```

The descriptor contains `schemaVersion: 1`, a lowercase underscore-separated
`brand`, alphanumeric `moduleName` beginning with a capital, Android `packageName`,
and lowercase `apkSha256` and `certificateSha256` hashes. SDK `aapt` and
`apksigner` must be on PATH or supplied with `--aapt` / `--apksigner`. Debug APKs
require `--development`; signer and byte hashes are enforced in both modes.

Copy the new directory under the AOSP vendor tree and inherit its `product.mk`
from the selected product. The generated Soong import is presigned, nonprivileged,
and additive. Device provisioning must select the HOME role. The helper does not
replace the full local-agent APK contract, grant roles, build an image, or qualify
boot, OTA, Chromium signer admission, or physical hardware. Keep those checks
separate. Test with `node --test packages/os/scripts/__tests__/stage-launcher-overlay.node.test.ts`.

To stage a second package of the same product, such as its update supervisor, add
`companions: [{ moduleName, packageName, apkSha256 }]` to the descriptor and pass
`--companion MODULE=PATH` for each one. A companion must carry exactly the
launcher's signer (`certificateSha256`), a different package and module name, and
no HOME activity. It is staged in the launcher's partition as another presigned,
nonprivileged import, and it gets no default permissions.

A launcher that runs code from its native library directory (for example the Eliza
runtime's musl loader and Bun) needs its `lib/<abi>` beside the app: Android never
extracts a bundled app's libraries, and Soong's `android_app_import` installs none.
Pass `--native-abi arm64-v8a` (or `x86_64`) to install them. The helper reads every
`lib/<abi>/*.so` entry from the same hash-pinned private copy it stages; each must be
stored (as `preprocessed` already requires), a flat library name, a little-endian
ELF64 for that ABI and match its CRC, else nothing is staged. The launcher then moves
to `Android.mk`, AOSP's supported prebuilt app rule (`LOCAL_PREBUILT_JNI_LIBS`),
which installs the libraries in `<partition>/app/<module>/lib/<arch>` and keeps the
presigned APK. Grants and companions stay in `Android.bp`. `config.fs` gives the
shared runtime's loader and Bun mode 0755 and every other library 0644, and
`product.mk` adds it to `TARGET_FS_CONFIG_GEN`. `native-libraries.json` records each
library's APK entry, install path, mode and SHA-256. It is not runtime admission
(`runtimeAdmitted: false`): the libraries are only the reviewed APK's own bytes.

That rule needs a product that still reads `Android.mk`. A Soong-only product
(`PRODUCT_SOONG_ONLY`; Android 17 Cuttlefish sets it from `RELEASE_SOONG_ONLY_CUTTLEFISH`,
which `cp2a` inherits as true) never reads it. For one, also pass
`--native-install soong`. The launcher then stays an `android_app_import` that
`required`s one `prebuilt_app_native` module per library, installed at the same
`<partition>/app/<module>/lib/<arch>` path with the same `config.fs` modes, and no
`Android.mk` is written. `prebuilt_app_native` is the reviewed
`patches/soong-app-native` build/soong extension (the type `stage-android-native.py
--finalize-soong` emits); apply that exact patch in the AOSP checkout first, or Soong
refuses the unknown module type. Its base, build/soong `6722dd88`, is the
`android-17.0.0_r1` revision. `native-libraries.json` then records
`installRule: "soong-app-native"` and the patch manifest's SHA-256. The default
(`--native-install make`) is the `Android.mk` rule above.

For a downstream **system-only GSI**, set `partition: "system"` in the reviewed
launcher descriptor. Both the nonprivileged APK and optional revocable permission
file then install in `/system`; the default remains `/product`. Inherit the staged
`product.mk` in the consumer's own AOSP product. This does not select an Android
release, add Treble compatibility patches, or import Eliza's launcher identity.

`lenovo-ideatab-tb336fu` records an observed stock candidate and remains blocked.
The linked community Android 16 package is an unofficial GSI retaining Lenovo's
`.271` vendor/kernel stack, not a device source port or evidence for Eliza's
Android 17 target. Read-only stock qualification cannot enable installation.

## Common Pixel 10a product composition

The explicit Pixel 10a path uses the same hardware composition for both launchers:
`products/pixel10a-eliza.json` and `products/pixel10a-alpha.json` vary the product
name, model, brand and launcher package/module. Device configuration, the stock
kernel, eSIM flags provider, source patches and SELinux inputs live once under
`devices/pixel10a`. Both main APKs are presigned, nonprivileged product apps.
`eliza_common.mk` is not included by this target. The Cuttlefish, grizzly and GSI
products use the same nonprivileged-launcher profile through `eliza_common.mk`
(see [Eliza image launcher](#eliza-image-launcher)).

```bash
make -C packages/os/android stage-pixel10a ARGS="--product packages/os/android/products/pixel10a-eliza.json --launcher-descriptor /absolute/launcher.json --apk /absolute/launcher.apk --aosp-root /absolute/aosp --vendor-archive /absolute/factory.zip --output /absolute/new-overlay --source-commit REVIEWED_ELIZA_COMMIT --development"
```

Use the Alpha product JSON with its matching admitted launcher descriptor for the
other consumer. Full source verification runs before staging. The shared launcher
stager authenticates APK bytes, signer and HOME activity; provisioning takes the
HOME and assistant component names from that admitted APK. Autofill is offered
only when its guarded service is present. The current Eliza manifest has no such
service. The original stock launcher remains installed.

A product that leaves capture over Keyguard to the system Camera2 sets
`launcher.refuseLockScreenSurfaces: true` (the Alpha product does). Staging then
refuses a launcher APK whose manifest shows an activity over Keyguard
(`showWhenLocked`, `showOnLockScreen`, `turnScreenOn`) or handles a secure-capture
action, before any output is moved into place. Eliza's product leaves it unset
because its launcher keeps an alarm ringing activity over Keyguard.

The output must be installed at `vendor/alphaphone`: the immutable generated
`stallion.mk` references `vendor/alphaphone/stallion/device.mk`. This compatibility
path and the retained `AlphaPixelConfig` internal module names are provenance,
not a different application identity. Do not rename those source references by
editing the shared source inventory; a future move needs a reviewed patch envelope.

`composePixel10aProduct` also supports an already admitted downstream overlay,
including Alpha's existing runtime/native staging. If a listener has been staged,
its allowlist must contain exactly `CAPTURE_AUDIO_HOTWORD` and
`START_ACTIVITIES_FROM_BACKGROUND` for the matching `.sense` package. The common
renderer for this policy grants neither network access nor `RECORD_AUDIO`.
The caller must still authenticate that separate APK, its speech payload and its
indicator configuration before composition.

This command also verifies and stages resident JNI through the shared native
admission module. `--source-commit` is the full reviewed Eliza runtime revision;
`--runtime-source` optionally selects the Git repository holding that commit.
The Bun pin is read from the committed object, and the APK build receipt must
bind that source revision, package, runtime provenance and all final runtime bytes.
`--bun-target android` selects the separately pinned native Android Bun artifact;
the default remains `linux-musl`. Alpha supplies its existing exact source stamp,
view-policy and workflow lock through a thin adapter to the same verifier.
`nativeLibrariesStaged` is true only with an explicit matching admission receipt
and unchanged staged native bytes; a Makefile alone is not evidence. Eliza's separate
Sense APK,
shared Autofill implementation, full exact-source image build, voice/telephony and
physical device acceptance remain open. No source or device is written by the
composer, and the physical target remains installer-ineligible and unqualified.

Native admission is shared by both product consumers in
`scripts/android/stage-android-native.py`. Callers authenticate the source contract;
the common module enforces archive uniqueness, ABI/ELF/compression, runtime file
hashes, asset/JNI parity, the stable Bun binary pin, and source/worker bindings.
The Eliza source contract checks `META-INF/eliza/aosp-build-provenance.json` and
its final packaged-file closure. The downstream exact-JSON contract retains its
preparer, dependency-lock and view-policy checks without putting product-specific
file paths or source hashes into the shared implementation. These are byte and
source-admission checks: `runtimeVerified`, `deployReady`, image/boot and device
qualification remain false.
